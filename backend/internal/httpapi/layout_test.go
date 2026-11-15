package httpapi

import (
	"folio/internal/auth"
	"folio/internal/config"
	"folio/internal/layout"
	"folio/internal/storage"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func TestManagedLayoutHTTPIsolationAndCoreDatabase(t *testing.T) {
	base := t.TempDir()
	w := filepath.Join(base, "workspace")
	d := filepath.Join(base, "data")
	for _, dir := range []string{w, d} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	a, err := auth.Open(d, "layout-test-password")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	cfg := config.Config{Workspace: w, AppData: d, Limits: storage.DefaultLimits, IndexLimit: 1 << 20}
	h, err := NewAccounts(fstest.MapFS{}, cfg, a)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	entry, err := h.get(1)
	if err != nil {
		t.Fatal(err)
	}
	_, secret, err := a.CreateAccessToken(1, entry.id, "isolation", 0, auth.TokenPermissions{Files: "write", Search: "read", Trash: "write"})
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range []string{"/files/content?path=", "/files/download?path=", "/files/metadata?path=", "/entries/revision?path=", "/workspace/tree?path="} {
		r := httptest.NewRequest(http.MethodGet, "/api/v1"+route+url.QueryEscape(".folio/trash/private.md"), nil)
		r.Header.Set("Authorization", "Bearer "+secret)
		response := httptest.NewRecorder()
		h.ServeHTTP(response, r)
		if response.Code != 400 || !strings.Contains(response.Body.String(), "path_invalid") {
			t.Fatalf("内部路径未被拒绝 %s: %d %s", route, response.Code, response.Body.String())
		}
	}
	_, err = entry.store.Write("note.md", "原文", "", true)
	if err != nil {
		t.Fatal(err)
	}
	rev, err := entry.store.EntryRevision("note.md")
	if err != nil {
		t.Fatal(err)
	}
	record, err := entry.store.Trash("note.md", rev.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(w, "1", ".folio", "trash", record.ID, "payload")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"shares", "grants"} {
		var n int
		if err = a.Database().QueryRow("SELECT count(*) FROM " + name).Scan(&n); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = os.Stat(filepath.Join(d, "shares", "shares.db")); !os.IsNotExist(err) {
		t.Fatal("创建了独立分享库", err)
	}
	if err = h.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = a.User(1); err != nil {
		t.Fatal("分享关闭导致核心库关闭", err)
	}
	// 即使保留旧目录，完成标记也确保重启不重复导入。
	if err = os.MkdirAll(filepath.Join(d, "1", "trash"), 0700); err != nil {
		t.Fatal(err)
	}
	h, err = NewAccounts(fstest.MapFS{}, cfg, a)
	if err != nil {
		t.Fatal(err)
	}
	h.Close()
}
func TestLegacyLayoutRequiresExplicitMigration(t *testing.T) {
	base := t.TempDir()
	w := filepath.Join(base, "workspace")
	d := filepath.Join(base, "data")
	for _, dir := range []string{w, d, filepath.Join(d, "1", "trash")} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	a, err := auth.Open(d, "layout-test-password")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	_, err = NewAccounts(fstest.MapFS{}, config.Config{Workspace: w, AppData: d}, a)
	if err == nil || !strings.Contains(err.Error(), "-migrate-storage") {
		t.Fatal("旧布局未提示显式迁移", err)
	}
	complete, e := layout.Complete(a.Database())
	if e != nil || complete {
		t.Fatal(complete, e)
	}
}
