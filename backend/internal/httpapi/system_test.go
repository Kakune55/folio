package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"folio/internal/auth"
	"folio/internal/config"
	"folio/internal/storage"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func TestSystemSettingsStatusAndPersistence(t *testing.T) {
	root, data := t.TempDir(), t.TempDir()
	accounts, err := auth.Open(data, "system-test-password-2026")
	if err != nil {
		t.Fatal(err)
	}
	defer accounts.Close()
	cfg := config.Config{Workspace: root, AppData: data, Limits: storage.DefaultLimits, IndexLimit: 1 << 20}
	assets := fstest.MapFS{"index.html": {Data: []byte("Folio")}}
	manager, err := NewAccounts(assets, cfg, accounts)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { manager.Close() }()
	token, p, err := accounts.Login("admin", "system-test-password-2026", "", "admin")
	if err != nil {
		t.Fatal(err)
	}
	call := func(method, path string, body any, session, csrf string) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		r := httptest.NewRequest(method, "/api/v1"+path, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-CSRF-Token", csrf)
		if session != "" {
			r.Header.Set("Cookie", cookieName+"="+session)
		}
		w := httptest.NewRecorder()
		manager.ServeHTTP(w, r)
		return w
	}
	for _, path := range []string{"/admin/settings", "/admin/status", "/admin/disk"} {
		if w := call("GET", path, nil, "", ""); w.Code != 401 {
			t.Fatalf("anonymous %s: %d", path, w.Code)
		}
	}
	entry, err := manager.get(p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = entry.store.Write("sample.txt", "中文关键词"+strings.Repeat("x", 40), "", true); err != nil {
		t.Fatal(err)
	}
	entry.index.Changed("sample.txt")
	settings := systemSettings{storage.Limits{Text: 64, Image: 128, PDF: 128, Attachment: 128, ImagePixels: 100}, 8}
	if w := call("PUT", "/admin/settings", settings, token, ""); w.Code != 403 {
		t.Fatalf("csrf %d", w.Code)
	}
	if w := call("PUT", "/admin/settings", settings, token, p.CSRF); w.Code != 200 {
		t.Fatalf("save %d %s", w.Code, w.Body)
	}
	if entry.store.Limits().Text != 64 {
		t.Fatal("existing workspace limits stale")
	}
	if _, err := entry.store.Write("large.txt", strings.Repeat("x", 65), "", true); err == nil {
		t.Fatal("text limit not enforced")
	}
	deadline := time.Now().Add(3 * time.Second)
	for entry.index.Status().Indexing && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	result, err := entry.index.FileState(context.Background(), "sample.txt", "")
	if err != nil || result.State != "too_large" || result.BodyLimit != 8 {
		t.Fatalf("index limit %+v %v", result, err)
	}
	settings.IndexLimit = 128
	if w := call("PUT", "/admin/settings", settings, token, p.CSRF); w.Code != 200 {
		t.Fatal(w.Body)
	}
	for entry.index.Status().Indexing && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	result, err = entry.index.FileState(context.Background(), "sample.txt", "")
	if err != nil || result.State != "indexed" {
		t.Fatalf("rebuild %+v %v", result, err)
	}
	bad := settings
	bad.Limits.Image = 129
	if w := call("PUT", "/admin/settings", bad, token, p.CSRF); w.Code != 400 {
		t.Fatalf("invalid settings %d", w.Code)
	}
	if entry.store.Limits() != settings.Limits {
		t.Fatal("invalid settings applied")
	}
	user, err := accounts.SaveUser(0, auth.UserInput{Username: "ordinary", Password: "ordinary-password-2026", Enabled: true, Quota: 1024})
	if err != nil {
		t.Fatal(err)
	}
	userToken, up, err := accounts.Login("ordinary", "ordinary-password-2026", "", "ordinary")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/admin/settings", "/admin/status", "/admin/disk"} {
		if w := call("GET", path, nil, userToken, up.CSRF); w.Code != 403 {
			t.Fatalf("user %s: %d", path, w.Code)
		}
	}
	if w := call("PUT", "/admin/settings", settings, userToken, up.CSRF); w.Code != 403 {
		t.Fatal("user changed settings")
	}
	next, err := manager.get(user.ID)
	if err != nil || next.store.Limits() != settings.Limits {
		t.Fatal("new workspace settings", err)
	}
	if w := call("GET", "/admin/status", nil, token, p.CSRF); w.Code != 200 || !strings.Contains(w.Body.String(), "goroutines") {
		t.Fatalf("runtime %d %s", w.Code, w.Body)
	}
	os.Mkdir(filepath.Join(root, "1", "empty"), 0700)
	if w := call("GET", "/admin/disk", nil, token, p.CSRF); w.Code != 200 || !strings.Contains(w.Body.String(), "available") {
		t.Fatalf("disk %d %s", w.Code, w.Body)
	}
	if err = manager.Close(); err != nil {
		t.Fatal(err)
	}
	manager, err = NewAccounts(assets, cfg, accounts)
	if err != nil {
		t.Fatal(err)
	}
	if manager.cfg.Limits != settings.Limits || manager.cfg.IndexLimit != 128 {
		t.Fatal("settings lost after reopen")
	}
}
