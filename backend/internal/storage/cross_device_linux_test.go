package storage

import (
	"bytes"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"testing"
)

func TestCrossDeviceTrashDirectory(t *testing.T) {
	store, root := testStore(t)
	directory, err := os.MkdirTemp("/dev/shm", "folio-trash-test-")
	if err != nil {
		t.Skip("无可用的第二文件系统")
	}
	t.Cleanup(func() { os.RemoveAll(directory) })
	var a, b unix.Stat_t
	if unix.Stat(root, &a) != nil || unix.Stat(directory, &b) != nil || a.Dev == b.Dev {
		t.Skip("未提供跨设备测试环境")
	}
	withTrash(t, store, directory)
	if err = store.Mkdir("项目"); err != nil {
		t.Fatal(err)
	}
	if err = store.Mkdir("项目/附件"); err != nil {
		t.Fatal(err)
	}
	data := []byte{0, 1, 2, 3, 255}
	if err = os.WriteFile(filepath.Join(root, "项目/附件/图.bin"), data, 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err = store.Write("项目/说明.md", "# 你好\n", "", true); err != nil {
		t.Fatal(err)
	}
	revision, err := store.EntryRevision("项目")
	if err != nil {
		t.Fatal(err)
	}
	record, err := store.Trash("项目", revision.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if record.Stage != "" || record.State != "ready" {
		t.Fatalf("跨盘删除未完成：%+v", record)
	}
	if _, err = os.Stat(filepath.Join(root, "项目")); !os.IsNotExist(err) {
		t.Fatal("跨盘删除后原目录存在")
	}
	if _, err = store.Restore(record.ID); err != nil {
		t.Fatal(err)
	}
	restored, err := os.ReadFile(filepath.Join(root, "项目/附件/图.bin"))
	if err != nil || !bytes.Equal(restored, data) {
		t.Fatal("跨盘恢复字节不一致")
	}
	info, err := os.Stat(filepath.Join(root, "项目/附件/图.bin"))
	if err != nil || info.Mode().Perm() != 0o640 {
		t.Fatal("跨盘恢复未保留权限")
	}
	final, err := store.EntryRevision("项目")
	if err != nil || final.Revision != revision.Revision {
		t.Fatal("跨盘恢复树摘要不一致")
	}
}
