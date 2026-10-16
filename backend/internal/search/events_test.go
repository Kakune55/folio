package search

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"folio/internal/storage"
)

func TestChangedScopesAndLatestContent(t *testing.T) {
	index, store, root := setup(t)
	for _, dir := range []string{"中文_%", "中文_%extra"} {
		if err := store.Mkdir(dir); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"中文_%/note.txt", "中文_%extra/keep.txt", "unrelated.txt"} {
		if _, err := store.Write(name, "original_token", "", true); err != nil {
			t.Fatal(err)
		}
	}
	index.Refresh(true)
	ready(t, index, "")
	// 外部修改不通知；其他路径的 API 事件不得顺带扫描整个工作区。
	if err := os.WriteFile(filepath.Join(root, "unrelated.txt"), []byte("external_token"), 0600); err != nil {
		t.Fatal(err)
	}
	before := index.Status().IndexedAt
	for n := 0; n < 20; n++ {
		if err := os.WriteFile(filepath.Join(root, "中文_%", "note.txt"), []byte(fmt.Sprintf("latest_token_%d", n)), 0600); err != nil {
			t.Fatal(err)
		}
		index.Changed("中文_%/note.txt")
	}
	ready(t, index, before)
	if len(find(t, index, "latest_token_19", "").Entries) != 1 {
		t.Fatal("未索引最终磁盘内容")
	}
	if len(find(t, index, "external_token", "").Entries) != 0 {
		t.Fatal("单路径更新扫描了无关文件")
	}
	if index.Status().Files != 3 {
		t.Fatal("增量更新破坏全局文件计数")
	}
	before = index.Status().IndexedAt
	if err := os.Rename(filepath.Join(root, "中文_%"), filepath.Join(root, "moved")); err != nil {
		t.Fatal(err)
	}
	index.Changed("中文_%", "moved")
	ready(t, index, before)
	if len(find(t, index, "中文_%/", "names").Entries) != 0 || len(find(t, index, "moved/note", "names").Entries) != 1 {
		t.Fatal("移动子树未正确更新")
	}
	if len(find(t, index, "中文_%extra/keep", "names").Entries) != 1 {
		t.Fatal("子树边界误删相似前缀")
	}
	before = index.Status().IndexedAt
	if err := os.Remove(filepath.Join(root, "moved", "note.txt")); err != nil {
		t.Fatal(err)
	}
	index.Changed("moved")
	ready(t, index, before)
	if len(find(t, index, "latest_token", "").Entries) != 0 || index.Status().Files != 2 {
		t.Fatal("删除未清理索引或文件计数错误")
	}
}

func TestQueueMergesSubtreesBoundsAndPreservesNewEvents(t *testing.T) {
	index := &Index{pendingPaths: map[string]struct{}{}, requests: make(chan struct{}, 1)}
	index.Changed("a/one", "a/two", "a", "a/three", "ab/keep", "../unsafe")
	batch, ok := index.take()
	if !ok || len(batch.paths) != 2 || batch.paths[0] != "a" || batch.paths[1] != "ab/keep" {
		t.Fatalf("未合并重叠子树：%+v", batch)
	}
	index.Changed("during.txt")
	index.completed = batch.generation
	next, ok := index.take()
	if !ok || len(next.paths) != 1 || next.paths[0] != "during.txt" {
		t.Fatal("处理中新增事件丢失")
	}
	index.completed = next.generation
	for n := 0; n < 257; n++ {
		index.Changed(fmt.Sprintf("file-%d", n))
	}
	overflow, ok := index.take()
	if !ok || overflow.paths != nil || len(index.pendingPaths) != 0 {
		t.Fatal("队列溢出未合并为全量核对")
	}
	index.Refresh(true)
	index.Changed("after-rebuild.txt")
	rebuild, _ := index.take()
	if !rebuild.full || rebuild.paths != nil {
		t.Fatal("手动重建请求被增量事件覆盖")
	}
}

func TestIdleDoesNotPollAndManualRebuildReconciles(t *testing.T) {
	index, _, root := setup(t)
	ready(t, index, "")
	before := index.Status().IndexedAt
	if err := os.WriteFile(filepath.Join(root, "external.txt"), []byte("external_only_token"), 0600); err != nil {
		t.Fatal(err)
	}
	// 跨过原来的 10 秒轮询周期；闲置时不应扫描或改变完成时间。
	time.Sleep(11 * time.Second)
	if status := index.Status(); status.Indexing || status.IndexedAt != before {
		t.Fatalf("闲置时出现后台扫描：%+v", status)
	}
	if len(find(t, index, "external_only_token", "").Entries) != 0 {
		t.Fatal("未通知的外部变更被自动索引")
	}
	index.Refresh(true)
	ready(t, index, before)
	if len(find(t, index, "external_only_token", "").Entries) != 1 {
		t.Fatal("手动重建未核对外部变更")
	}
}

func TestStartupRepairsMissedEventsAndChangedBodyLimit(t *testing.T) {
	root, data := t.TempDir(), t.TempDir()
	store, err := storage.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.Write("deleted.txt", "deleted_token", "", true); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Write("limited.txt", "longer_body_token", "", true); err != nil {
		t.Fatal(err)
	}
	index, err := Open(data, store, 4)
	if err != nil {
		t.Fatal(err)
	}
	ready(t, index, "")
	if err := index.Close(); err != nil {
		t.Fatal(err)
	}
	// 模拟写入已经提交，但进程退出前没有发送或处理索引事件。
	if err := os.Remove(filepath.Join(root, "deleted.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Write("missed.txt", "missed_event_token", "", true); err != nil {
		t.Fatal(err)
	}
	index, err = Open(data, store, 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer index.Close()
	ready(t, index, "")
	if len(find(t, index, "deleted.txt", "names").Entries) != 0 || len(find(t, index, "missed_event_token", "").Entries) != 1 || len(find(t, index, "longer_body_token", "").Entries) != 1 {
		t.Fatal("启动未补偿遗漏事件、删除或正文限额变化")
	}
}

func TestIncrementalFailureKeepsWarningUntilFullRecovery(t *testing.T) {
	index, store, _ := setup(t)
	ready(t, index, "")
	if _, err := store.Write("note.txt", "recoverable_token", "", true); err != nil {
		t.Fatal(err)
	}
	index.dbMu.Lock()
	db := index.db
	index.db = nil
	index.dbMu.Unlock()
	index.Changed("note.txt")
	deadline := time.Now().Add(3 * time.Second)
	for index.Status().Indexing && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if index.Status().Warning == "" {
		t.Fatal("索引故障没有提示")
	}
	index.dbMu.Lock()
	index.db = db
	index.dbMu.Unlock()
	before := index.Status().IndexedAt
	index.Changed("note.txt")
	deadline = time.Now().Add(3 * time.Second)
	for index.Status().Indexing && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if index.Status().IndexedAt == before || index.Status().Warning == "" {
		t.Fatal("后续局部成功不应掩盖尚未核对的故障")
	}
	index.Refresh(true)
	ready(t, index, before)
	if _, err := index.Query(context.Background(), "recoverable_token", "", 50); err != nil {
		t.Fatal(err)
	}
}

func TestEventsArrivingDuringScanAreNotLost(t *testing.T) {
	index, store, _ := setup(t)
	ready(t, index, "")
	before := index.Status().IndexedAt
	if _, err := store.Write("first.txt", "during_scan_token", "", true); err != nil {
		t.Fatal(err)
	}
	index.dbMu.Lock()
	index.Changed("first.txt")
	deadline := time.Now().Add(3 * time.Second)
	taken := false
	for time.Now().Before(deadline) {
		index.mu.Lock()
		taken = len(index.pendingPaths) == 0
		index.mu.Unlock()
		if taken {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !taken {
		index.dbMu.Unlock()
		t.Fatal("工作线程未提取任务")
	}
	var group sync.WaitGroup
	for n := 0; n < 30; n++ {
		name := fmt.Sprintf("parallel-%d.txt", n)
		if _, err := store.Write(name, "during_scan_token", "", true); err != nil {
			index.dbMu.Unlock()
			t.Fatal(err)
		}
		group.Add(1)
		go func() { defer group.Done(); index.Changed(name) }()
	}
	group.Wait()
	index.dbMu.Unlock()
	ready(t, index, before)
	if len(find(t, index, "during_scan_token", "").Entries) != 31 {
		t.Fatal("索引处理中到达的并发事件丢失")
	}
}
