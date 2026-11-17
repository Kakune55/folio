package search

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestLiteralExcerpt(t *testing.T) {
	for _, sample := range []struct {
		name, body, query, want string
	}{
		{"空正文", "", "query", ""},
		{"中文", "前言：中文全文检索。", "中文全文", "前言：中文全文检索。"},
		{"英文大小写", "before REQUEST_ID after", "request_id", "before REQUEST_ID after"},
		{"转义正则", "before [a-z]+(x)?.* after", "[a-z]+(x)?.*", "before [a-z]+(x)?.* after"},
		{"Unicode折叠", strings.Repeat("甲", 200) + "Kelvin 结尾", "kelvin", "…" + strings.Repeat("甲", 50) + "Kelvin 结尾"},
		{"中间命中", strings.Repeat("前", 200) + "目标词" + strings.Repeat("后", 200), "目标词", "…" + strings.Repeat("前", 50) + "目标词" + strings.Repeat("后", 127) + "…"},
		{"文末命中", strings.Repeat("🙂", 200) + "文末目标", "文末目标", "…" + strings.Repeat("🙂", 50) + "文末目标"},
		{"只取首次命中", "目标词" + strings.Repeat("甲", 200) + "目标词", "目标词", "目标词" + strings.Repeat("甲", 177) + "…"},
		{"仅路径命中", strings.Repeat("甲", 200), "path_only", strings.Repeat("甲", 180) + "…"},
		{"长查询", strings.Repeat("前", 200) + strings.Repeat("词", 200) + "后", strings.Repeat("词", 200), "…" + strings.Repeat("前", 38) + strings.Repeat("词", 200) + "…"},
		{"跨分片", strings.Repeat("a", 32766) + "目标词" + "结尾", "目标词", "…" + strings.Repeat("a", 50) + "目标词结尾"},
		{"分片跨Unicode", strings.Repeat("🙂", 8191) + "前目标词结尾", "目标词", "…" + strings.Repeat("🙂", 49) + "前目标词结尾"},
		{"跨分片不同字节大小写", strings.Repeat("a", 32767) + "ſſſ结尾", "sss", "…" + strings.Repeat("a", 50) + "ſſſ结尾"},
	} {
		t.Run(sample.name, func(t *testing.T) {
			match := regexp.MustCompile(`(?i)` + regexp.QuoteMeta(sample.query))
			got, err := literalExcerpt(context.Background(), sample.body, match, utf8.RuneCountInString(sample.query))
			if err != nil || got != sample.want || !utf8.ValidString(got) || utf8.RuneCountInString(got) > 240 {
				t.Fatalf("摘要=%q，期望=%q，错误=%v", got, sample.want, err)
			}
		})
	}
}

func TestQueryExcerptPreservesRankingAndTruncation(t *testing.T) {
	index, _, _ := setup(t)
	ready(t, index, "")
	// 直接构建隔离索引样本，核对 FTS 匹配和排名，不依赖摘要算法决定文件集合。
	for n := 0; n < 65; n++ {
		name := fmt.Sprintf("folder/note-%02d.md", n)
		body := strings.Repeat("request_id 中文全文 Kelvin ÄPFEL ΣΙΓΜΑ 🙂 ", n+1)
		if n == 0 {
			name, body = "request_id.md", "只在路径命中"
		} else if n == 1 {
			name, body = "empty-request_id.bin", ""
		}
		if _, err := index.db.Exec("INSERT INTO documents(path,body,stamp) VALUES(?,?,?)", name, body, "sample"); err != nil {
			t.Fatal(err)
		}
	}
	for _, query := range []string{"request_id", "中文全文", "kelvin", "äpfel", "σιγμα", "not_present", `foo" OR 1=1 --`} {
		literal := `"` + strings.ReplaceAll(query, `"`, `""`) + `"`
		rows, err := index.db.Query(`SELECT path FROM documents WHERE documents MATCH ? ORDER BY bm25(documents),path`, literal)
		if err != nil {
			t.Fatal(err)
		}
		var want []string
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				t.Fatal(err)
			}
			want = append(want, name)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
		if (query == "kelvin" || query == "äpfel" || query == "σιγμα") && len(want) == 0 {
			t.Fatalf("Unicode 样本未命中：%q", query)
		}
		for _, limit := range []int{1, 2, 50, 200} {
			got, err := index.Query(context.Background(), query, "", limit)
			if err != nil {
				t.Fatal(err)
			}
			if len(got.Entries) != min(len(want), limit) || got.Truncated != (len(want) > limit) || got.Limit != limit {
				t.Fatalf("查询=%q limit=%d：%+v", query, limit, got)
			}
			match := regexp.MustCompile(`(?i)` + regexp.QuoteMeta(query))
			for n, entry := range got.Entries {
				if entry.Path != want[n] || !utf8.ValidString(entry.Excerpt) || utf8.RuneCountInString(entry.Excerpt) > 240 {
					t.Fatalf("排名或摘要无效：%+v，期望=%s", entry, want[n])
				}
				if entry.Path == "empty-request_id.bin" {
					if entry.Excerpt != "" {
						t.Fatalf("空正文摘要=%q", entry.Excerpt)
					}
				} else if entry.Path == "request_id.md" {
					if entry.Excerpt != "只在路径命中" {
						t.Fatalf("路径命中摘要=%q", entry.Excerpt)
					}
				} else if !match.MatchString(entry.Excerpt) {
					t.Fatalf("摘要缺少命中：查询=%q，摘要=%q", query, entry.Excerpt)
				}
			}
		}
	}
}

func TestQueryAndExcerptCancellation(t *testing.T) {
	index, _, _ := setup(t)
	ready(t, index, "")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := index.Query(ctx, "request_id", "", 50); err == nil {
		t.Fatal("取消查询应返回错误")
	}
	for _, body := range []string{"", strings.Repeat("x", 100000)} {
		if _, err := literalExcerpt(ctx, body, regexp.MustCompile("missing"), 7); !errors.Is(err, context.Canceled) {
			t.Fatalf("取消摘要返回：%v", err)
		}
	}
}

type excerptCancelProbe struct {
	context.Context
	cancel context.CancelFunc
	checks int
}

func (c *excerptCancelProbe) Err() error {
	c.checks++
	if c.checks == 2 {
		c.cancel()
	}
	return c.Context.Err()
}

func TestExcerptCancellationBetweenChunks(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	probe := &excerptCancelProbe{Context: ctx, cancel: cancel}
	// 在第二次检查时取消，确定性覆盖扫描已开始但尚未完成的路径。
	_, err := literalExcerpt(probe, strings.Repeat("甲", 100000), regexp.MustCompile("missing"), 7)
	if !errors.Is(err, context.Canceled) || probe.checks != 2 {
		t.Fatalf("分片间取消未生效：错误=%v，检查次数=%d", err, probe.checks)
	}
}

func TestQueryExcerptSnapshotDuringRefresh(t *testing.T) {
	index, _, _ := setup(t)
	ready(t, index, "")
	for n := 0; n < 60; n++ {
		if _, err := index.db.Exec("INSERT INTO documents(path,body,stamp) VALUES(?,?,?)", fmt.Sprintf("note-%02d.md", n), "request_id version-old", "old"); err != nil {
			t.Fatal(err)
		}
	}
	done := make(chan error, 1)
	go func() {
		for n := 0; n < 20; n++ {
			body := "request_id version-old"
			if n%2 == 0 {
				body = "request_id version-new"
			}
			if _, err := index.db.Exec("UPDATE documents SET body=?", body); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	// 即使断言失败，也先等写入者退出，再关闭测试索引。
	defer func() {
		if err := <-done; err != nil {
			t.Errorf("并发刷新失败：%v", err)
		}
	}()
	for n := 0; n < 20; n++ {
		result := find(t, index, "request_id", "")
		if len(result.Entries) != 50 || !result.Truncated {
			t.Fatalf("快照结果不完整：%+v", result)
		}
		version := result.Entries[0].Excerpt
		if version != "request_id version-old" && version != "request_id version-new" {
			t.Fatalf("未知版本：%q", version)
		}
		for _, entry := range result.Entries {
			if entry.Excerpt != version {
				t.Fatalf("一次查询混入不同版本：%q / %q", version, entry.Excerpt)
			}
		}
	}
}
