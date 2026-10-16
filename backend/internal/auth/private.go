package auth

import (
	"errors"
	"folio/internal/fileio"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// app-data 的用户/ACL 隔离由部署负责；应用仍拒绝静态链接和特殊账号文件。
func privateDirectory(directory string) (*os.Root, error) {
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(absolute)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("应用数据路径必须是实际目录")
	}
	return os.OpenRoot(absolute)
}
func createPrivateFile(root *os.Root, name string) (*os.File, error) {
	return root.OpenFile(name, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
}
func privateFile(root *os.Root, name string, create bool) (*os.File, error) {
	file, err := fileio.Open(root, name, os.O_RDWR, 0)
	if errors.Is(err, os.ErrNotExist) && create {
		return createPrivateFile(root, name)
	}
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, errors.New("账号文件必须是普通文件")
	}
	return file, nil
}

// ReadPasswordFile 有界读取普通文件，密码不进入命令行或日志；目录权限由部署者管理。
func ReadPasswordFile(filename string) (string, error) {
	absolute, err := filepath.Abs(filename)
	if err != nil {
		return "", err
	}
	root, err := os.OpenRoot(filepath.Dir(absolute))
	if err != nil {
		return "", err
	}
	defer root.Close()
	file, err := fileio.Open(root, filepath.Base(absolute), os.O_RDONLY, 0)
	if err != nil {
		return "", err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("密码文件必须是普通文件")
	}
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
