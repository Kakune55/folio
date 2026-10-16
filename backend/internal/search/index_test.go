package search

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"folio/internal/storage"
)

func setup(t *testing.T) (*Index, *storage.Store, string) {
	t.Helper()
	root := t.TempDir()
	store, err := storage.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	index, err := Open(t.TempDir(), store, 1024)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { index.Close() })
	return index, store, root
}
func ready(t *testing.T, index *Index, after string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		status := index.Status()
		if !status.Indexing && status.IndexedAt != "" && status.IndexedAt != after && status.Warning == "" {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("索引未就绪：%+v", index.Status())
}
func find(t *testing.T, index *Index, q, mode string) Response {
	t.Helper()
	results, err := index.Query(context.Background(), q, mode, 50)
	if err != nil {
		t.Fatal(err)
	}
	return results
}
func TestChineseEnglishPathsAndLiteralQueries(t *testing.T) {
	index, store, root := setup(t)
	if err := store.Mkdir("Linux"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Write("Linux/中文笔记.md", "网络规划包含交换机、路由器与 VLAN。request_id=abc-123 是技术标识符。\n", "", true); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "preview.pdf"), []byte("%PDF-1.7\nPDF_ONLY_SECRET"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/passwd", filepath.Join(root, "unsafe.md")); err != nil {
		if runtime.GOOS != "windows" {
			t.Fatal(err)
		}
		t.Logf("当前 Windows 无符号链接权限，跳过链接样本：%v", err)
	}
	index.Refresh(true)
	ready(t, index, "")
	for _, q := range []string{"网络规划", "交换机", "网络", "网", "request_id", "abc-123", "Linux/中文"} {
		result := find(t, index, q, "")
		if len(result.Entries) != 1 || result.Entries[0].Path != "Linux/中文笔记.md" {
			t.Fatalf("查询 %q：%+v", q, result)
		}
	}
	if len(find(t, index, "中文", "names").Entries) != 1 {
		t.Fatal("文件名短查询失败")
	}
	if len(find(t, index, "VLAN", "names").Entries) != 0 {
		t.Fatal("快开误搜正文")
	}
	if len(find(t, index, "PDF_ONLY_SECRET", "").Entries) != 0 {
		t.Fatal("错误提取 PDF 内容")
	}
	if len(find(t, index, "preview.pdf", "names").Entries) != 1 {
		t.Fatal("附件文件名未索引")
	}
	if len(find(t, index, `foo" OR 1=1 --`, "").Entries) != 0 {
		t.Fatal("查询语法未按字面量处理")
	}
	if len(find(t, index, "unsafe", "names").Entries) != 0 {
		t.Fatal("不安全符号链接进入索引")
	}
}
func TestReconcileMoveDeleteAndSameMtimeEdits(t *testing.T) {
	index, store, root := setup(t)
	rev, err := store.Write("before.md", "old_unique_token", "", true)
	if err != nil {
		t.Fatal(err)
	}
	index.Refresh(true)
	ready(t, index, "")
	previous := index.Status().IndexedAt
	info, _ := os.Stat(filepath.Join(root, "before.md"))
	if err = os.WriteFile(filepath.Join(root, "before.md"), []byte("new_unique_token"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err = os.Chtimes(filepath.Join(root, "before.md"), info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	index.Refresh(false)
	ready(t, index, previous)
	if len(find(t, index, "new_unique_token", "").Entries) != 1 || len(find(t, index, "old_unique_token", "").Entries) != 0 {
		t.Fatal("相同 mtime 的外部修改未重建正文")
	}
	current, err := store.Read("before.md")
	if err != nil {
		t.Fatal(err)
	}
	rev = current.Revision
	if err = store.Move("before.md", "after.md", rev); err != nil {
		t.Fatal(err)
	}
	previous = index.Status().IndexedAt
	index.Refresh(false)
	ready(t, index, previous)
	if len(find(t, index, "before", "names").Entries) != 0 || len(find(t, index, "after", "names").Entries) != 1 {
		t.Fatal("移动路径未更新")
	}
	if err = os.Remove(filepath.Join(root, "after.md")); err != nil {
		t.Fatal(err)
	}
	previous = index.Status().IndexedAt
	index.Refresh(false)
	ready(t, index, previous)
	if len(find(t, index, "new_unique_token", "").Entries) != 0 {
		t.Fatal("删除文件仍作为当前结果")
	}
}
func TestCorruptCacheRebuildDoesNotTouchFiles(t *testing.T) {
	root := t.TempDir()
	store, err := storage.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err = store.Write("真实文件.md", "文件仍是唯一权威来源", "", true); err != nil {
		t.Fatal(err)
	}
	data := t.TempDir()
	if err = os.WriteFile(filepath.Join(data, "search.db"), []byte("损坏的索引缓存"), 0o600); err != nil {
		t.Fatal(err)
	}
	index, err := Open(data, store, 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer index.Close()
	if _, err = index.Query(context.Background(), "权威", "", 50); err == nil {
		t.Fatal("损坏缓存没有显式报错")
	}
	if _, err = store.Write("独立编辑.md", "索引失败仍可写入", "", true); err != nil {
		t.Fatal("索引故障阻塞写入")
	}
	index.Refresh(true)
	ready(t, index, "")
	if len(find(t, index, "权威", "").Entries) != 1 {
		t.Fatal("无法从真实文件重建")
	}
	files, _ := os.ReadDir(data)
	found := false
	for _, file := range files {
		if strings.HasPrefix(file.Name(), "search-recovery-") {
			found = true
		}
	}
	if !found {
		t.Fatal("损坏缓存未保留诊断副本")
	}
}

// 按内容识别文本，不通过扩展名白名单限制配置、源码或无扩展名文件。
func TestCommonTextBodiesAndBinaryExclusion(t *testing.T) {
	index, _, root := setup(t)
	names := []string{"note.txt", "server.log", "data.json", "config.yaml", "settings.toml", "app.ini", "data.csv", "main.go", "script.py", "app.ts", "style.css", "page.html", "icon.svg", ".env", "Dockerfile", "LICENSE", "unknown.custom"}
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(root, name), []byte("文本索引正文 common_text_token\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for name, body := range map[string][]byte{
		"binary.bin":   []byte("common_text_token\x00"),
		"legacy.txt":   append([]byte("common_text_token"), 0xff),
		"large.txt":    []byte(strings.Repeat("x", 1025) + "common_text_token"),
		"document.pdf": []byte("%PDF-1.7 common_text_token"),
	} {
		if err := os.WriteFile(filepath.Join(root, name), body, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	index.Refresh(true)
	ready(t, index, "")
	results := find(t, index, "common_text_token", "")
	if len(results.Entries) != len(names) {
		t.Fatalf("常见文本正文索引不完整或混入二进制：%+v", results)
	}
	for _, name := range names {
		found := false
		for _, entry := range results.Entries {
			if entry.Path == name {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("正文未索引：%s", name)
		}
	}
	if len(find(t, index, "binary.bin", "names").Entries) != 1 {
		t.Fatal("二进制名称应可检索")
	}
}
