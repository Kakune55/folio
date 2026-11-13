package fileio

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestCheckSingleLink(t *testing.T) {
	root := t.TempDir()
	name := filepath.Join(root, "file.bin")
	file, err := os.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err = CheckSingleLink(file); err != nil {
		t.Fatal("普通单链接文件被拒绝", err)
	}
	alias := filepath.Join(root, "alias.bin")
	if err = os.Link(name, alias); err != nil {
		t.Fatal(err)
	}
	if err = CheckSingleLink(file); !errors.Is(err, ErrUnsafe) {
		t.Fatal("已打开描述符未拒绝新增硬链接", err)
	}
	if err = os.Remove(alias); err != nil {
		t.Fatal(err)
	}
	if err = CheckSingleLink(file); err != nil {
		t.Fatal("移除别名后未恢复单链接", err)
	}
	if err = file.Close(); err != nil {
		t.Fatal(err)
	}
	if err = CheckSingleLink(file); err == nil || errors.Is(err, ErrUnsafe) {
		t.Fatal("关闭描述符未保留原生查询错误", err)
	}
}
