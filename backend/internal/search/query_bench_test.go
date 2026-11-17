package search

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// 与浏览器性能样本保持相同的文件数量及正文分布，不计入文件写入和索引构建时间。
func BenchmarkQuery(b *testing.B) {
	db, err := openDB(filepath.Join(b.TempDir(), "search.db"))
	if err != nil {
		b.Fatal(err)
	}
	defer db.Close()
	tx, err := db.Begin()
	if err != nil {
		b.Fatal(err)
	}
	defer tx.Rollback()
	for n := 0; n < 1202; n++ {
		name := fmt.Sprintf("QA-性能/note-%04d.md", n)
		body := fmt.Sprintf("# 性能样本 %d\n\nrequest_id 中文全文检索。\n", n)
		if n == 1200 {
			name = "QA-性能/large.md"
			body = "# 较大 Markdown\n\n"
			for paragraph := 0; paragraph < 600; paragraph++ {
				if paragraph > 0 {
					body += "\n\n"
				}
				body += fmt.Sprintf("第 %d 段：真实文件是正文权威。%s", paragraph, strings.Repeat("中文阅读与编辑保持独立缓冲区。", 5))
			}
			body += "\n"
		} else if n == 1201 {
			name = "QA-性能/large.log"
			body = strings.Repeat("request_id=trace-123456 level=info message="+strings.Repeat("x", 160)+"\n", 5200)
		}
		if _, err = tx.Exec("INSERT INTO documents(path,body,stamp) VALUES(?,?,?)", name, body, "sample"); err != nil {
			b.Fatal(err)
		}
	}
	if err = tx.Commit(); err != nil {
		b.Fatal(err)
	}
	index := &Index{db: db}
	// 拆分高频词的排序及单份日志摘要成本；字面截取只作对照，不代表等价替换。
	for _, probe := range []struct{ name, sql string }{
		{"RankOnly", `SELECT path,'' FROM documents WHERE documents MATCH ? ORDER BY bm25(documents),path LIMIT 51`},
		{"SnippetOnlyLarge", `SELECT path,snippet(documents,1,'','','…',30) FROM documents WHERE documents MATCH ? AND path='QA-性能/large.log'`},
		{"LiteralExcerpt", `SELECT path,substr(body,max(1,instr(lower(body),lower('request_id'))-50),180) FROM documents WHERE documents MATCH ? ORDER BY bm25(documents),path LIMIT 51`},
	} {
		b.Run(probe.name, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				rows, err := db.Query(probe.sql, `"request_id"`)
				if err != nil {
					b.Fatal(err)
				}
				count := 0
				for rows.Next() {
					var name, excerpt string
					if err := rows.Scan(&name, &excerpt); err != nil {
						b.Fatal(err)
					}
					count++
				}
				if err := rows.Err(); err != nil {
					b.Fatal(err)
				}
				rows.Close()
				want := 51
				if probe.name == "SnippetOnlyLarge" {
					want = 1
				}
				if count != want {
					b.Fatalf("结果数量=%d，期望=%d", count, want)
				}
			}
		})
	}
	for _, sample := range []struct {
		name, query, mode string
		count             int
		truncated         bool
	}{
		{"Names", "QA-性能/note-1199", "names", 1, false},
		{"FullCommon", "request_id", "", 50, true},
		{"FullShort", "中文", "", 50, true},
		{"FullAbsent", "not_present", "", 0, false},
	} {
		b.Run(sample.name, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				result, err := index.Query(context.Background(), sample.query, sample.mode, 50)
				if err != nil {
					b.Fatal(err)
				}
				if len(result.Entries) != sample.count || result.Truncated != sample.truncated {
					b.Fatalf("查询结果不符合样本预期：%+v", result)
				}
			}
		})
	}
}
