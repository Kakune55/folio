package storage

import (
	"context"
	"errors"
	"testing"
)

func TestIndexUsageCountsTowardQuotaForBothBackends(t *testing.T) {
	for _, backend := range []string{"local", "s3"} {
		t.Run(backend, func(t *testing.T) {
			var w Workspace
			if backend == "local" {
				s, e := Open(t.TempDir())
				if e != nil {
					t.Fatal(e)
				}
				w = s
			} else {
				b, _, _ := newRemote(t)
				s, e := b.OpenUser(1)
				if e != nil {
					t.Fatal(e)
				}
				w = s
			}
			defer w.Close()
			w.SetQuota(func() (int64, error) { return 10, nil })
			indexBytes := int64(7)
			w.SetIndexUsage(func() (int64, error) { return indexBytes, nil })
			rev, err := w.Write("a.md", "123", "", true)
			if err != nil {
				t.Fatal(err)
			}
			u, err := w.Usage()
			if err != nil || u.Used != 10 {
				t.Fatal(u, err)
			}
			details, err := w.StorageDetails(context.Background())
			if err != nil || details.Usage != u {
				t.Fatal(details, err)
			}
			found := false
			for _, c := range details.Categories {
				if c.Key == "index" {
					found = true
					if c.Bytes != 7 {
						t.Fatal(c)
					}
				}
			}
			if !found {
				t.Fatal("未单列搜索索引")
			}
			// 索引允许系统增长超额，但后续业务增长不能绕过配额。
			indexBytes = 20
			if _, err = w.Write("new.md", "1", "", true); !isCode(err, "quota_exceeded") {
				t.Fatal("超额后允许新建", err)
			}
			if _, err = w.Write("a.md", "1234", rev, false); !isCode(err, "quota_exceeded") {
				t.Fatal("超额后允许增长", err)
			}
			if _, err = w.Write("a.md", "1", rev, false); err != nil {
				t.Fatal("超额阻止缩小正文", err)
			}
			if _, err = w.Read("a.md"); err != nil {
				t.Fatal("超额阻止读取", err)
			}
			w.SetIndexUsage(func() (int64, error) { return 0, errors.New("统计失败") })
			if _, err = w.Usage(); err == nil {
				t.Fatal("忽略统计失败")
			}
			if _, err = w.StorageDetails(context.Background()); err == nil {
				t.Fatal("分类忽略统计失败")
			}
			if _, err = w.Write("new.md", "1", "", true); err == nil {
				t.Fatal("统计失败放行增长")
			}
		})
	}
}
