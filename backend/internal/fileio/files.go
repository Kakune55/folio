// Package fileio 使用标准库管理根目录内的文件；仅进程锁、不覆盖移动和根身份保留平台适配。
package fileio

import (
	"errors"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

var ErrLink = errors.New("不支持符号链接")

var ErrUnsafe = errors.New("不支持链接或特殊文件")

// Open 在打开前排除静态链接和特殊文件，实际路径隔离由 os.Root 保证。
// 部署者须保护目录，不能允许不协作的本机程序并发替换目录或特殊文件。
func Open(root *os.Root, name string, flags int, mode os.FileMode) (*os.File, error) {
	parts := strings.Split(name, "/")
	var before os.FileInfo
	for i := range parts {
		info, err := root.Lstat(strings.Join(parts[:i+1], "/"))
		if err != nil {
			return nil, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, ErrLink
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return nil, ErrUnsafe
		}
		before = info
	}
	file, err := root.OpenFile(name, flags, mode)
	if err != nil {
		return nil, err
	}
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) || (!after.IsDir() && !after.Mode().IsRegular()) {
		file.Close()
		if err != nil {
			return nil, err
		}
		return nil, ErrUnsafe
	}
	return file, nil
}

func Stat(root *os.Root) (os.FileInfo, error) { return root.Stat(".") }

// Windows 不提供与 Unix 相同的目录 fsync 保证；文件正文仍必须 Sync。
func Sync(file *os.File) error {
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if runtime.GOOS == "windows" && info.IsDir() {
		return nil
	}
	return file.Sync()
}
func SyncRoot(root *os.Root) error {
	file, err := root.Open(".")
	if err != nil {
		return err
	}
	defer file.Close()
	return Sync(file)
}

// Rename 只接收已打开的父目录与单个名称，禁止借此绕过工作区解析。
func Rename(from *os.Root, old string, to *os.Root, name string) error {
	if !fs.ValidPath(old) || !fs.ValidPath(name) || strings.ContainsAny(old+name, "/\\:") {
		return ErrUnsafe
	}
	return renameNoReplace(from, old, to, name)
}

// FileURL 使用 SQLite 能识别的跨平台 file URI，Windows 盘符前保留斜线。
func FileURL(filename string) string {
	name := filepath.ToSlash(filename)
	if !strings.HasPrefix(name, "/") {
		name = "/" + name
	}
	return (&url.URL{Scheme: "file", Path: name}).String()
}
