package httpapi

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"folio/internal/storage"
)

func TestMCPReadCoverage(t *testing.T) {
	c := newMCPReadCoverage()
	now := time.Unix(1000, 0)
	c.now = func() time.Time { return now }
	key := mcpReadKey{1, 2, "workspace", "note.md", "revision"}
	content := storage.Content{Content: "\ufeffa\r\nb\nc\r", Revision: key.revision}
	for _, start := range []int{3, 1, 1} {
		part, err := content.LineRange(start, 1)
		if err != nil {
			t.Fatal(err)
		}
		c.record(key, part)
		if c.allows(key) {
			t.Fatal("重复或缺行的读取被视为全文")
		}
	}
	part, _ := content.LineRange(2, 1)
	c.record(key, part)
	if !c.allows(key) {
		t.Fatal("乱序分段覆盖全文后未允许")
	}
	for _, other := range []mcpReadKey{{2, 2, "workspace", "note.md", "revision"}, {1, 3, "workspace", "note.md", "revision"}, {1, 2, "other", "note.md", "revision"}, {1, 2, "workspace", "other.md", "revision"}, {1, 2, "workspace", "note.md", "other"}} {
		if c.allows(other) {
			t.Fatal("跨身份、路径或版本复用了读取记录", other)
		}
	}
	now = now.Add(mcpReadCoverageTTL)
	if c.allows(key) || len(c.entries) != 0 {
		t.Fatal("过期记录未拒绝并清理")
	}
	for _, source := range []string{"", "\ufeff"} {
		part, _ := (storage.Content{Content: source}).LineRange(1, 100)
		c.record(key, part)
		if !c.allows(key) {
			t.Fatal("空文件/BOM-only全文未识别")
		}
	}
	for i := 0; i < mcpReadCoverageLimit+20; i++ {
		k := key
		k.path = fmt.Sprint(i)
		c.record(k, part)
		if len(c.entries) > mcpReadCoverageLimit {
			t.Fatal("读取记录无界增长")
		}
	}
}

func TestMCPReadCoverageConcurrent(t *testing.T) {
	c := newMCPReadCoverage()
	key := mcpReadKey{1, 2, "w", "p", "r"}
	var group sync.WaitGroup
	for i := 0; i < 40; i++ {
		group.Go(func() {
			c.record(key, &storage.LineContent{StartLine: 1, LineCount: 1, TotalLines: 1})
			_ = c.allows(key)
		})
	}
	group.Wait()
	if !c.allows(key) {
		t.Fatal("并发全文读取未保存")
	}
}
