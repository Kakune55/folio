package storage

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestQuotaPreservesContentAndCountsTrash(t *testing.T) {
	store, _ := testStore(t)
	withTrash(t, store, t.TempDir())
	quota := int64(10)
	store.SetQuota(func() (int64, error) { return quota, nil })
	revision, err := store.Write("note.txt", "12345678", "", true)
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.Write("note.txt", "12345678901", revision, false)
	code(t, err, "quota_exceeded")
	content, err := store.Read("note.txt")
	if err != nil || content.Content != "12345678" {
		t.Fatal("超额覆盖原文")
	}
	_, err = store.Upload("", "large.bin", bytes.NewBufferString("abc"), false)
	code(t, err, "quota_exceeded")
	if _, err = store.Metadata("large.bin"); err == nil {
		t.Fatal("超额上传提交目标")
	}
	usage, err := store.Usage()
	if err != nil || usage.Used != 8 {
		t.Fatalf("失败上传计费错误：%+v %v", usage, err)
	}
	_, err = store.Upload("", "ok.bin", bytes.NewBufferString("ab"), false)
	if err != nil {
		t.Fatal(err)
	}
	record, err := store.Trash("note.txt", revision)
	if err != nil {
		t.Fatal(err)
	}
	usage, err = store.Usage()
	if err != nil || usage.Used != 10 {
		t.Fatal("回收站计费错误", usage, err)
	}
	quota = 0
	if _, err = store.Restore(record.ID); err != nil {
		t.Fatal("恢复不应增加总用量", err)
	}
	next, err := store.Write("note.txt", "x", revision, false)
	if err != nil {
		t.Fatal("超额缩小失败", err)
	}
	_, err = store.Write("note.txt", "xx", next, false)
	code(t, err, "quota_exceeded")
	record, err = store.Trash("note.txt", next)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Purge(record.ID); err != nil {
		t.Fatal(err)
	}
	usage, err = store.Usage()
	if err != nil || usage.Used != 2 {
		t.Fatal("清理未释放额度", usage, err)
	}
}

func TestQuotaFailureAndStreamingBoundary(t *testing.T) {
	store, _ := testStore(t)
	store.SetQuota(func() (int64, error) { return 0, errors.New("额度服务故障") })
	if _, err := store.Write("blocked.txt", "x", "", true); err == nil {
		t.Fatal("统计失败静默放行")
	}
	store.SetQuota(func() (int64, error) { return 3, nil })
	source := strings.NewReader(strings.Repeat("x", 1<<20))
	_, err := store.Upload("", "huge.bin", source, false)
	code(t, err, "quota_exceeded")
	if source.Len() < (1<<20)-8192 {
		t.Fatal("超额后仍读取完整上传")
	}
}
