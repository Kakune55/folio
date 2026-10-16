//go:build linux

package auth

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

// SQLite 会自行打开 sidecar；应用数据必须由当前用户独占管理。
// 不支持在同 UID 的不协作程序持续改写该私有目录时操作账号库。
func privateDirectory(path string) (*os.File, error) {
	fd, err := unix.Openat2(unix.AT_FDCWD, path, &unix.OpenHow{
		Flags:   unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC,
		Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS,
	})
	if err != nil {
		return nil, fmt.Errorf("无法安全打开应用数据目录：%w", err)
	}
	file := os.NewFile(uintptr(fd), "app-data")
	var info unix.Stat_t
	if err = unix.Fstat(fd, &info); err != nil || info.Uid != uint32(os.Geteuid()) || info.Mode&0o7077 != 0 {
		file.Close()
		return nil, errors.New("应用数据目录必须属于运行用户，且仅允许该用户访问（0700）")
	}
	return file, nil
}

func createPrivateFile(root *os.File, name string) (*os.File, error) {
	fd, err := unix.Openat2(int(root.Fd()), name, &unix.OpenHow{
		Flags:   unix.O_RDWR | unix.O_CREAT | unix.O_EXCL | unix.O_CLOEXEC,
		Mode:    0o600,
		Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_XDEV,
	})
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), name), nil
}

func privateFile(root *os.File, name string, create bool) (*os.File, error) {
	fd, err := unix.Openat2(int(root.Fd()), name, &unix.OpenHow{
		Flags:   unix.O_PATH | unix.O_CLOEXEC,
		Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_XDEV,
	})
	if errors.Is(err, unix.ENOENT) && create {
		return createPrivateFile(root, name)
	}
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	if err = checkPrivateFile(fd); err != nil {
		return nil, fmt.Errorf("不安全的账号文件 %s：%w", name, err)
	}
	opened, err := unix.Open(fmt.Sprintf("/proc/self/fd/%d", fd), unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(opened), name), nil
}

func checkPrivateFile(fd int) error {
	var info unix.Stat_t
	if err := unix.Fstat(fd, &info); err != nil {
		return err
	}
	if info.Mode&unix.S_IFMT != unix.S_IFREG || info.Nlink != 1 || info.Uid != uint32(os.Geteuid()) || info.Mode&0o7077 != 0 {
		return errors.New("必须是当前用户独占的普通文件（0600），拒绝链接、特殊文件和共享权限")
	}
	return nil
}

// ReadPasswordFile 有界读取私有普通文件，密码不进入命令行参数或日志。
func ReadPasswordFile(path string) (string, error) {
	fd, err := unix.Openat2(unix.AT_FDCWD, path, &unix.OpenHow{
		Flags:   unix.O_PATH | unix.O_CLOEXEC,
		Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS,
	})
	if err != nil {
		return "", errors.New("无法安全打开密码文件，请使用无符号链接的实际路径")
	}
	defer unix.Close(fd)
	if err = checkPrivateFile(fd); err != nil {
		return "", err
	}
	readFD, err := unix.Open(fmt.Sprintf("/proc/self/fd/%d", fd), unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return "", err
	}
	file := os.NewFile(uintptr(readFD), "password-file")
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 1027))
	if err != nil {
		return "", err
	}
	password := string(data)
	if strings.HasSuffix(password, "\n") {
		password = strings.TrimSuffix(strings.TrimSuffix(password, "\n"), "\r")
	}
	if len(data) > 1026 || len(password) < 12 || len(password) > 1024 || !utf8.ValidString(password) || strings.ContainsAny(password, "\x00\r\n") {
		return "", errors.New("密码须为 12 到 1024 字节的 UTF-8 文本，不能含换行或 NUL；允许文件末尾一组 LF/CRLF")
	}
	return password, nil
}
