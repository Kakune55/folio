package storage

import (
	"context"
	"folio/internal/trash"
	"os"
	"path/filepath"
	"testing"
)

func TestStorageBreakdownMatchesQuota(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	bin, err := trash.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer bin.Close()
	store.SetTrash(bin)
	store.SetQuota(func() (int64, error) { return 1000, nil })
	store.SetExtraUsage(func() (int64, error) { return 7, nil })
	for name, content := range map[string]string{"note.md": "123", "image.PNG": "1234", "video.mp4": "12", "code.go": "12345", "deleted.txt": "123456", ".folio-tmp-save": "ignored", ".folio-tmp-trash-isolated": "12"} {
		if err = os.WriteFile(filepath.Join(dir, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	rev, err := store.EntryRevision("deleted.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.Trash("deleted.txt", rev.Revision); err != nil {
		t.Fatal(err)
	}
	details, err := store.StorageDetails(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	usage, err := store.Usage()
	if err != nil {
		t.Fatal(err)
	}
	if details.Usage != usage || details.Used != 29 {
		t.Fatalf("分类与配额不符 %+v %+v", details, usage)
	}
	expected := map[string]int64{"documents": 3, "images": 4, "media": 2, "other": 7, "trash": 6, "shares": 7}
	for _, category := range details.Categories {
		if category.Bytes != expected[category.Key] {
			t.Fatal(category)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = store.StorageDetails(ctx); err == nil {
		t.Fatal("忽略取消")
	}
	if err = os.Symlink(filepath.Join(dir, "note.md"), filepath.Join(dir, "unsafe")); err != nil {
		t.Skip("环境不支持符号链接", err)
	}
	if _, err = store.StorageDetails(context.Background()); err == nil {
		t.Fatal("不安全条目被忽略")
	}
}
