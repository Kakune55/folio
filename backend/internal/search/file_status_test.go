package search

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"folio/internal/storage"
)

func TestDefaultFiveMiBLimitAndFileStatus(t *testing.T) {
	root, data := t.TempDir(), t.TempDir()
	store, err := storage.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	body := strings.Repeat(" ", int(DefaultBodyLimit)-len("血尸")) + "血尸"
	revision, err := store.Write("novel.txt", body, "", true)
	if err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string][]byte{"large.txt": []byte(strings.Repeat("x", int(DefaultBodyLimit)+1)), "binary.bin": []byte("binary\x00"), "empty.txt": {}} {
		if err := os.WriteFile(filepath.Join(root, name), body, 0600); err != nil {
			t.Fatal(err)
		}
	}
	index, err := Open(data, store, DefaultBodyLimit)
	if err != nil {
		t.Fatal(err)
	}
	defer index.Close()
	ready(t, index, "")
	if DefaultBodyLimit != 5<<20 || len(find(t, index, "血尸", "").Entries) != 1 {
		t.Fatal("5 MiB 边界文本未进入正文搜索")
	}
	for name, want := range map[string]string{"novel.txt": "indexed", "large.txt": "too_large", "binary.bin": "names_only", "empty.txt": "indexed"} {
		result, err := index.FileState(context.Background(), name, "")
		if err != nil || result.State != want || result.BodyLimit != 5<<20 {
			t.Fatalf("%s 状态不符：%+v %v", name, result, err)
		}
	}
	indexed, err := index.FileState(context.Background(), "novel.txt", revision)
	if err != nil || indexed.State != "indexed" || indexed.Size != DefaultBodyLimit {
		t.Fatalf("已保存版本或大小不符：%+v %v", indexed, err)
	}
	stale, err := index.FileState(context.Background(), "novel.txt", "sha256:outdated")
	if err != nil || stale.State != "not_indexed" {
		t.Fatalf("旧版本不能显示已索引：%+v %v", stale, err)
	}
	if err := os.WriteFile(filepath.Join(root, "unnotified.txt"), []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	missing, err := index.FileState(context.Background(), "unnotified.txt", "")
	if err != nil || missing.State != "not_indexed" {
		t.Fatalf("漏索引状态不符：%+v %v", missing, err)
	}
	index.mu.Lock()
	index.requested++
	index.mu.Unlock()
	pending, err := index.FileState(context.Background(), "unnotified.txt", "")
	if err != nil || pending.State != "pending" {
		t.Fatalf("排队状态不符：%+v %v", pending, err)
	}
	index.mu.Lock()
	index.completed = index.requested
	index.status.Warning = "测试故障"
	index.mu.Unlock()
	failed, err := index.FileState(context.Background(), "novel.txt", revision)
	if err != nil || failed.State != "error" {
		t.Fatalf("故障未明确显示：%+v %v", failed, err)
	}
	if _, err := index.FileState(context.Background(), "../outside", ""); err == nil {
		t.Fatal("状态接口未拒绝越界路径")
	}
}
