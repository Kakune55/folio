package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"folio/internal/auth"
	"folio/internal/search"
	"folio/internal/storage"
)

func BenchmarkSearchHTTP(b *testing.B) {
	root, data := b.TempDir(), b.TempDir()
	paths := make(map[string]bool, 1202)
	write := func(name, body string) {
		b.Helper()
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0600); err != nil {
			b.Fatalf("写入性能样本 %s 失败：%v", name, err)
		}
		paths[name] = true
	}
	for n := 0; n < 1200; n++ {
		write(fmt.Sprintf("note-%04d.md", n), fmt.Sprintf("# 性能样本 %d\n\nrequest_id 中文全文检索。\n", n))
	}
	// 大文件正文与浏览器性能样本一致，文件写入及索引构建不计时。
	var rich strings.Builder
	rich.WriteString("# 较大 Markdown\n\n")
	for n := 0; n < 600; n++ {
		if n > 0 {
			rich.WriteString("\n\n")
		}
		fmt.Fprintf(&rich, "第 %d 段：真实文件是正文权威。%s", n, strings.Repeat("中文阅读与编辑保持独立缓冲区。", 5))
	}
	rich.WriteString("\n")
	write("large.md", rich.String())
	write("large.log", strings.Repeat("request_id=trace-123456 level=info message="+strings.Repeat("x", 160)+"\n", 5200))

	store, err := storage.Open(root)
	if err != nil {
		b.Fatalf("打开临时工作区失败：%v", err)
	}
	defer store.Close()
	accounts, err := auth.Open(data, "search-bench-password-123")
	if err != nil {
		b.Fatalf("初始化认证失败：%v", err)
	}
	defer accounts.Close()
	index, err := search.Open(data, store, search.DefaultBodyLimit)
	if err != nil {
		b.Fatalf("打开搜索索引失败：%v", err)
	}
	defer index.Close()
	deadline := time.Now().Add(30 * time.Second)
	for {
		status := index.Status()
		if status.Warning != "" {
			b.Fatalf("索引出现警告：%+v", status)
		}
		if !status.Indexing && status.Files == 1202 {
			break
		}
		if time.Now().After(deadline) {
			b.Fatalf("等待 1202 个文件索引完成超时：%+v", status)
		}
		time.Sleep(10 * time.Millisecond)
	}
	token, _, err := accounts.Login("admin", "search-bench-password-123", "", "local")
	if err != nil {
		b.Fatalf("登录失败：%v", err)
	}
	server := httptest.NewServer(New(fstest.MapFS{}, Options{Auth: accounts, Workspace: store, Search: index}))
	defer server.Close()
	client := server.Client()
	client.Timeout = 5 * time.Second
	defer client.CloseIdleConnections()

	for _, sample := range []struct {
		name, query, mode string
		count             int
		truncated         bool
	}{
		{"Names", "note-1199", "names", 1, false},
		{"FullCommon", "request_id", "", 50, true},
	} {
		b.Run(sample.name, func(b *testing.B) {
			endpoint := server.URL + "/api/v1/search?" + url.Values{"q": {sample.query}, "mode": {sample.mode}}.Encode()
			b.ReportAllocs()
			var maximum time.Duration
			for b.Loop() {
				start := time.Now()
				request, err := http.NewRequest(http.MethodGet, endpoint, nil)
				if err != nil {
					b.Fatalf("创建搜索请求失败：%v", err)
				}
				request.AddCookie(&http.Cookie{Name: cookieName, Value: token})
				response, err := client.Do(request)
				if err != nil {
					b.Fatalf("搜索请求失败：%v", err)
				}
				body, readErr := io.ReadAll(response.Body)
				closeErr := response.Body.Close()
				if readErr != nil || closeErr != nil {
					b.Fatalf("读取搜索响应失败：读取=%v，关闭=%v", readErr, closeErr)
				}
				if response.StatusCode != http.StatusOK {
					b.Fatalf("搜索状态码=%d，预期=200：%s", response.StatusCode, body)
				}
				var result search.Response
				if err := json.Unmarshal(body, &result); err != nil {
					b.Fatalf("解析搜索 JSON 失败：%v", err)
				}
				if len(result.Entries) != sample.count || result.Truncated != sample.truncated || result.Limit != 50 {
					b.Fatalf("搜索结果数量或截断状态不符：%+v", result)
				}
				if result.Status.Indexing || result.Status.Warning != "" || result.Status.Files != 1202 {
					b.Fatalf("搜索索引状态不符：%+v", result.Status)
				}
				seen := make(map[string]bool, len(result.Entries))
				for _, entry := range result.Entries {
					if !paths[entry.Path] || seen[entry.Path] {
						b.Fatalf("搜索返回未知或重复路径：%s", entry.Path)
					}
					seen[entry.Path] = true
					if sample.mode == "names" {
						if entry.Path != "note-1199.md" {
							b.Fatalf("名称搜索路径不符：%s", entry.Path)
						}
					} else if !strings.Contains(entry.Excerpt, "request_id") {
						b.Fatalf("全文搜索摘要未包含 request_id：%+v", entry)
					}
				}
				maximum = max(maximum, time.Since(start))
			}
			b.ReportMetric(float64(maximum.Nanoseconds())/1e6, "max-ms/op")
			// 沿用浏览器性能样本的搜索 API 预算，不以平均值掩盖单次超限。
			if maximum >= 100*time.Millisecond {
				b.Fatalf("搜索单次最大耗时 %s 超出 100ms 预算", maximum)
			}
		})
	}
}
