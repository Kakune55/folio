package httpapi

import (
	"context"
	"encoding/json"
	"folio/internal/auth"
	"folio/internal/config"
	"folio/internal/s3test"
	"folio/internal/sharing"
	"folio/internal/storage"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func TestS3AccountsDownloadSharingAndSearch(t *testing.T) {

	fake := &s3test.Server{Objects: map[string]s3test.Object{}}
	server := httptest.NewServer(fake)
	defer server.Close()
	base := t.TempDir()
	d := filepath.Join(base, "data")
	if err := os.Mkdir(d, 0700); err != nil {
		t.Fatal(err)
	}
	a, err := auth.Open(d, "s3-integration-password")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	cfg := config.Config{StorageBackend: "s3", S3: storage.S3Options{AccessKey: "test-key", SecretKey: "test-secret", Bucket: "bucket", Endpoint: server.URL, Prefix: "folio", PathStyle: true}, Workspace: filepath.Join(base, "no-local-workspace"), AppData: d, Limits: storage.DefaultLimits, IndexLimit: 1 << 20}
	h, err := NewAccounts(fstest.MapFS{}, cfg, a)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	entry, err := h.get(1)
	if err != nil {
		t.Fatal(err)
	}
	rev, err := entry.store.Write("note.md", "# 远端索引测试\r\n", "", true)
	if err != nil {
		t.Fatal(err)
	}
	entry.index.Changed("note.md")
	_, secret, err := a.CreateAccessToken(1, entry.id, "integration", 0, auth.TokenPermissions{Files: "write", Search: "read", Trash: "write"})
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range []string{"/files/content?path=note.md", "/files/download?path=note.md"} {
		r := httptest.NewRequest("GET", "/api/v1"+route, nil)
		r.Header.Set("Authorization", "Bearer "+secret)
		response := httptest.NewRecorder()
		h.ServeHTTP(response, r)
		if response.Code != 200 || !strings.Contains(response.Body.String(), "远端索引测试") {
			t.Fatal(route, response.Code, response.Body.String())
		}
	}
	r := httptest.NewRequest("GET", "/api/v1/files/download?path=note.md", nil)
	r.Header.Set("Authorization", "Bearer "+secret)
	r.Header.Set("Range", "bytes=0-2")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, r)
	if response.Code != 206 || response.Body.Len() != 3 {
		t.Fatal("Range 不可用", response.Code, response.Body.String())
	}
	f, _, got, err := openMCPDownload(entry.store, "note.md", 1000)
	if err != nil || got != rev {
		t.Fatal(got, err)
	}
	data, _ := io.ReadAll(f)
	f.Close()
	if !strings.Contains(string(data), "远端索引测试") {
		t.Fatal(string(data))
	}
	share, err := h.shares.Save(1, "", sharing.Input{Title: "测试分享", Root: "note.md", Mode: "snapshot", Files: []storage.BundleFile{{Path: "note.md", Revision: rev}}})
	if err != nil {
		t.Fatal(err)
	}
	_, grant, err := h.shares.Enter(share.ID, "", "", "test")
	if err != nil {
		t.Fatal(err)
	}
	bundle, _, err := h.shares.File(share.ID, grant, share.Files[0].ID)
	if err != nil || string(bundle.Data) != string(data) {
		t.Fatal(bundle, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		result, e := entry.index.Query(ctx, "远端", "all", 20)
		if e == nil && len(result.Entries) > 0 {
			break
		}
		if ctx.Err() != nil {
			t.Fatal("S3 索引未就绪", e)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, err = os.Stat(cfg.Workspace); !os.IsNotExist(err) {
		t.Fatal("创建了本地正文目录", err)
	}
	cookie, _, err := a.Login("admin", "s3-integration-password", "", "test")
	if err != nil {
		t.Fatal(err)
	}
	r = httptest.NewRequest("GET", "/api/v1/admin/disk", nil)
	r.AddCookie(&http.Cookie{Name: cookieName, Value: cookie})
	response = httptest.NewRecorder()
	h.ServeHTTP(response, r)
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	var disk map[string]storage.DiskUsage
	if err = json.Unmarshal(response.Body.Bytes(), &disk); err != nil || disk["workspace"].Bytes == 0 || disk["workspace"].VolumeError == "" {
		t.Fatal(disk, err)
	}
}

func TestAccountsQuotaIncludesLocalIndexForBothBackends(t *testing.T) {
	for _, kind := range []string{"local", "s3"} {
		t.Run(kind, func(t *testing.T) {
			base := t.TempDir()
			workspace := filepath.Join(base, "workspace")
			data := filepath.Join(base, "data")
			for _, dir := range []string{workspace, data} {
				if err := os.Mkdir(dir, 0700); err != nil {
					t.Fatal(err)
				}
			}
			a, err := auth.Open(data, "quota-index-integration-password")
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close()
			cfg := config.Config{StorageBackend: kind, Workspace: workspace, AppData: data, Limits: storage.DefaultLimits, IndexLimit: 1 << 20}
			if kind == "s3" {
				server := httptest.NewServer(&s3test.Server{Objects: map[string]s3test.Object{}})
				defer server.Close()
				cfg.S3 = storage.S3Options{AccessKey: "key", SecretKey: "secret", Endpoint: server.URL, Bucket: "bucket", PathStyle: true}
			}
			h, err := NewAccounts(fstest.MapFS{}, cfg, a)
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			entry, err := h.get(1)
			if err != nil {
				t.Fatal(err)
			}
			// 停止后台任务使磁盘统计稳定，保留真实索引文件和生产计费回调。
			if err = entry.index.Close(); err != nil {
				t.Fatal(err)
			}
			var expected int64
			for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
				info, e := os.Stat(filepath.Join(data, "1", "search.db"+suffix))
				if os.IsNotExist(e) {
					continue
				}
				if e != nil {
					t.Fatal(e)
				}
				expected += info.Size()
			}
			if expected == 0 {
				t.Fatal("未创建索引数据库")
			}
			usage, err := h.options().UserUsage(1)
			if err != nil || usage.Used != expected {
				t.Fatal(usage, expected, err)
			}
			details, err := entry.store.StorageDetails(context.Background())
			if err != nil || details.Used != expected {
				t.Fatal(details, expected, err)
			}
			u, err := a.User(1)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = a.SaveUser(1, auth.UserInput{Username: u.Username, Enabled: true, Quota: expected}); err != nil {
				t.Fatal(err)
			}
			if _, err = entry.store.Write("blocked.md", "1", "", true); err == nil {
				t.Fatal("索引已占满额度却允许新建")
			}
		})
	}
}
