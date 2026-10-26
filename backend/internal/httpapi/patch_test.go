package httpapi

import (
	"encoding/json"
	"folio/internal/auth"
	"folio/internal/storage"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestPatchCookieCSRFAndValidation(t *testing.T) {
	store, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	accounts, err := auth.Open(t.TempDir(), "patch-password-123456")
	if err != nil {
		t.Fatal(err)
	}
	defer accounts.Close()
	session, principal, err := accounts.Login("admin", "patch-password-123456", "", "local")
	if err != nil {
		t.Fatal(err)
	}
	revision, err := store.Write("note.txt", "a\n", "", true)
	if err != nil {
		t.Fatal(err)
	}
	handler := New(fstest.MapFS{}, Options{Auth: accounts, Workspace: store, Origin: "https://folio.example"})
	call := func(body, etag, csrf, origin string, want int) {
		t.Helper()
		r := httptest.NewRequest("PATCH", "/api/v1/files/content?path=note.txt", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("If-Match", etag)
		r.Header.Set("X-CSRF-Token", csrf)
		r.Header.Set("Origin", origin)
		r.AddCookie(&http.Cookie{Name: cookieName, Value: session})
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("want %d got %d %s", want, w.Code, w.Body.String())
		}
	}
	body := `{"diff":"@@ -1 +1 @@\n-a\n+b\n","dryRun":true}`
	etag := `"` + revision + `"`
	call(body, etag, "", "https://folio.example", 403)
	call(body, etag, principal.CSRF, "https://other.example", 403)
	call(body, "*", principal.CSRF, "https://folio.example", 400)
	call(`{"diff":`, etag, principal.CSRF, "https://folio.example", 400)
	call(`{"diff":"text","unknown":true}`, etag, principal.CSRF, "https://folio.example", 400)
	raw, _ := json.Marshal(map[string]string{"diff": strings.Repeat("a", storage.PatchByteLimit+1)})
	call(string(raw), etag, principal.CSRF, "https://folio.example", 413)
	call(body, etag, principal.CSRF, "https://folio.example", 200)
	current, _ := store.Read("note.txt")
	if current.Content != "a\n" {
		t.Fatal("预检或失败请求改变了正文")
	}
}
