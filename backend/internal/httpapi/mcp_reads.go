package httpapi

import (
	"sort"
	"sync"
	"time"

	"folio/internal/auth"
	"folio/internal/storage"
)

const mcpReadCoverageTTL = 10 * time.Minute
const mcpReadCoverageLimit = 256

type mcpReadKey struct {
	owner, token              int64
	workspace, path, revision string
}
type mcpReadSpan struct{ from, to int }
type mcpReadRecord struct {
	expires  time.Time
	spans    []mcpReadSpan
	complete bool
}

// 只记录已成功交付的行区间，不保存正文；重启、过期或容量逐出后须重新读取。
type mcpReadCoverage struct {
	mu      sync.Mutex
	entries map[mcpReadKey]mcpReadRecord
	now     func() time.Time
}

func newMCPReadCoverage() *mcpReadCoverage {
	return &mcpReadCoverage{entries: make(map[mcpReadKey]mcpReadRecord), now: time.Now}
}

func (c *mcpReadCoverage) record(key mcpReadKey, content *storage.LineContent) {
	if content.IsPartial && content.LineCount == 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	for k, record := range c.entries {
		if !record.expires.After(now) {
			delete(c.entries, k)
		}
	}
	record, exists := c.entries[key]
	if !exists && len(c.entries) >= mcpReadCoverageLimit {
		var oldest mcpReadKey
		var expiry time.Time
		for k, record := range c.entries {
			if expiry.IsZero() || record.expires.Before(expiry) {
				oldest, expiry = k, record.expires
			}
		}
		delete(c.entries, oldest)
	}
	record.expires = now.Add(mcpReadCoverageTTL)
	if !content.IsPartial {
		record.complete = true
	}
	if !record.complete {
		record.spans = append(record.spans, mcpReadSpan{content.StartLine, content.StartLine + content.LineCount})
		sort.Slice(record.spans, func(i, j int) bool { return record.spans[i].from < record.spans[j].from })
		merged := record.spans[:0]
		for _, span := range record.spans {
			if len(merged) > 0 && span.from <= merged[len(merged)-1].to {
				merged[len(merged)-1].to = max(merged[len(merged)-1].to, span.to)
			} else {
				merged = append(merged, span)
			}
		}
		record.spans = merged
		record.complete = len(merged) == 1 && merged[0].from == 1 && merged[0].to > content.TotalLines
		if len(merged) > 128 {
			delete(c.entries, key)
			return
		}
	}
	if record.complete {
		record.spans = nil
	}
	c.entries[key] = record
}

func (c *mcpReadCoverage) allows(key mcpReadKey) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	record := c.entries[key]
	if !record.expires.After(c.now()) {
		delete(c.entries, key)
		return false
	}
	return record.complete
}

func (a *api) requireMCPFullRead(access *auth.AccessToken, path, revision string) error {
	if a.mcpReads.allows(mcpReadKey{a.OwnerID, access.ID, a.WorkspaceID, path, revision}) {
		return nil
	}
	current, err := a.Workspace.Read(path)
	if err != nil {
		return err
	}
	if current.Revision != revision {
		return &storage.Error{Code: "revision_conflict", Revision: current.Revision}
	}
	return mcpFullReadRequired()
}

func mcpFullReadRequired() error {
	return &mcpProblem{status: 409, code: "full_read_required", message: "同令牌尚未完整读取此版本，或读取记录已过期/逐出；请用readContent固定该版本读完全文，局部修改可用patchContent", details: map[string]any{"field": "expectedRevision", "action": "read_complete_revision", "ttlSeconds": int(mcpReadCoverageTTL.Seconds())}}
}
