package fileio

import (
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"os"
)

// 标准库尚无目录不覆盖重命名及跨进程文件锁；不以先检查再覆盖代替。
func renameNoReplace(from *os.Root, old string, to *os.Root, name string) error {
	a, err := from.Open(".")
	if err != nil {
		return err
	}
	defer a.Close()
	b, err := to.Open(".")
	if err != nil {
		return err
	}
	defer b.Close()
	return unix.Renameat2(int(a.Fd()), old, int(b.Fd()), name, unix.RENAME_NOREPLACE)
}
func Lock(file *os.File) error { return unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB) }
func Identity(root *os.Root) (string, error) {
	file, err := root.Open(".")
	if err != nil {
		return "", err
	}
	defer file.Close()
	var stat unix.Stat_t
	if err = unix.Fstat(int(file.Fd()), &stat); err != nil {
		return "", err
	}
	return fmt.Sprintf("%d:%d", stat.Dev, stat.Ino), nil
}
func CrossDevice(err error) bool { return errors.Is(err, unix.EXDEV) }
