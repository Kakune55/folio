package fileio

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestNoReplaceAndInstanceLock(t *testing.T) {
	directory := t.TempDir()
	root, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	for _, name := range []string{"source", "target"} {
		if err = root.WriteFile(name, []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err = Rename(root, "source", root, "target"); !errors.Is(err, os.ErrExist) {
		t.Fatalf("文件碰撞应拒绝：%v", err)
	}
	data, err := root.ReadFile("target")
	if err != nil || string(data) != "target" {
		t.Fatal("碰撞改变目标", err)
	}
	for _, name := range []string{"from", "to"} {
		if err = root.Mkdir(name, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err = Rename(root, "from", root, "to"); err == nil {
		t.Fatal("目录碰撞未拒绝")
	}
	if err = Rename(root, "from", root, "moved"); err != nil {
		t.Fatal(err)
	}
	a, err := root.OpenFile("instance.lock", os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := root.OpenFile("instance.lock", os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	if err = Lock(a); err != nil {
		t.Fatal(err)
	}
	if err = Lock(b); err == nil {
		t.Fatal("第二实例获得了锁")
	}
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}
	if err = Lock(b); err != nil {
		t.Fatal("关闭首实例后锁未释放", err)
	}
}

func TestRootContainmentAndStableIdentity(t *testing.T) {
	directory := t.TempDir()
	root, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	before, err := Identity(root)
	if err != nil {
		t.Fatal(err)
	}
	if err = root.WriteFile("note.md", []byte("原文"), 0o600); err != nil {
		t.Fatal(err)
	}
	after, err := Identity(root)
	if err != nil || before != after {
		t.Fatal("编辑改变了恢复命名空间", err)
	}
	other, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	different, err := Identity(other)
	if err != nil || different == before {
		t.Fatal("不同根目录身份相同", err)
	}
	outside := filepath.Join(t.TempDir(), "secret")
	if err = os.WriteFile(outside, []byte("外部"), 0o600); err != nil {
		t.Fatal(err)
	}
	if f, err := root.Open(outside); err == nil {
		f.Close()
		t.Fatal("绝对路径逃逸")
	}
	if err = Rename(root, "note.md", other, "../escape"); err == nil {
		t.Fatal("移动名称允许路径穿越")
	}
}
