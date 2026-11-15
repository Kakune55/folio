package search

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestUsageIncludesOnlyIndexFiles(t *testing.T) {
	directory := t.TempDir()
	index := &Index{filename: filepath.Join(directory, "search.db")}
	for name, data := range map[string]string{"search.db": "123", "search.db-wal": "1234", "search.db-shm": "12", "search.db-journal": "1", "other": "不计入", "trash": "旧数据不计入"} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	n, err := index.Usage()
	if err != nil || n != 10 {
		t.Fatal(n, err)
	}
	if err = os.Remove(filepath.Join(directory, "search.db-wal")); err != nil {
		t.Fatal(err)
	}
	n, err = index.Usage()
	if err != nil || n != 6 {
		t.Fatal(n, err)
	}
	if err = os.Remove(filepath.Join(directory, "search.db-shm")); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(filepath.Join(directory, "search.db-shm"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err = index.Usage(); err == nil {
		t.Fatal("接受非普通文件")
	}
}
func TestIndexingContinuesWhenQuotaExceeded(t *testing.T) {
	index, store, _ := setup(t)
	store.SetQuota(func() (int64, error) { return 1024, nil })
	if _, err := store.Write("note.md", "可搜索的原文", "", true); err != nil {
		t.Fatal(err)
	}
	store.SetIndexUsage(index.Usage)
	store.SetQuota(func() (int64, error) { return 1, nil })
	index.Refresh(true)
	ready(t, index, "")
	result, err := index.Query(context.Background(), "可搜索", "", 10)
	if err != nil || len(result.Entries) != 1 {
		t.Fatal(result, err)
	}
	usage, err := store.Usage()
	if err != nil || usage.Used <= usage.Quota {
		t.Fatal(usage, err)
	}
}
