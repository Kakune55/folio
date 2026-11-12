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

func TestRESTWriteDiagnosticsAndMoveRevision(t *testing.T) {
	e := newMCPTestEnv(t, "")
	_, secret := e.token(1, auth.TokenPermissions{Files: "write", Search: "none", Trash: "none"})
	call := func(method, path string, body any, revision string) *httptest.ResponseRecorder {
		t.Helper()
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(method, "/api/v1"+path, strings.NewReader(string(encoded)))
		r.Header.Set("Authorization", "Bearer "+secret)
		r.Header.Set("Content-Type", "application/json")
		if revision != "" {
			r.Header.Set("If-Match", `"`+revision+`"`)
		}
		w := httptest.NewRecorder()
		e.handler.ServeHTTP(w, r)
		return w
	}
	w := call("POST", "/files", map[string]string{"path": "source.txt", "content": "a\nb\n"}, "")
	var created struct{ Revision string }
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil || w.Code != 201 || created.Revision == "" {
		t.Fatalf("创建失败：%d %s %v", w.Code, w.Body.String(), err)
	}
	w = call("PATCH", "/files/content?path=source.txt", map[string]string{"diff": "@@ -2 +2 @@\n-wrong\n+B\n"}, created.Revision)
	var problem struct {
		Error struct {
			Code    string
			Details map[string]any
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &problem); err != nil {
		t.Fatal(err)
	}
	if w.Code != 409 || problem.Error.Code != "patch_mismatch" || problem.Error.Details["line"] != float64(2) || problem.Error.Details["reason"] != "deleted_content_mismatch" {
		t.Fatalf("REST未传递补丁定位：%s", w.Body.String())
	}
	current, err := e.handler.get(1)
	if err != nil {
		t.Fatal(err)
	}
	content, err := current.store.Read("source.txt")
	if err != nil || content.Revision != created.Revision || content.Content != "a\nb\n" {
		t.Fatalf("失配改变正文：%+v %v", content, err)
	}
	w = call("PATCH", "/entries/move", map[string]string{"from": "source.txt", "to": "moved.txt"}, created.Revision)
	var moved struct{ From, To, Revision string }
	if err := json.Unmarshal(w.Body.Bytes(), &moved); err != nil || w.Code != 200 || moved.Revision != created.Revision || moved.To != "moved.txt" {
		t.Fatalf("REST移动版本错误：%d %s %v", w.Code, w.Body.String(), err)
	}
	for _, endpoint := range []string{"/files", "/directories"} {
		body := map[string]string{"path": "missing/parent/entry"}
		if endpoint == "/files" {
			body["content"] = ""
		}
		w = call("POST", endpoint, body, "")
		problem.Error.Details = nil
		if err := json.Unmarshal(w.Body.Bytes(), &problem); err != nil {
			t.Fatal(err)
		}
		if w.Code != 404 || problem.Error.Code != "not_found" || problem.Error.Details["reason"] != "parent_not_found" || problem.Error.Details["path"] != "missing/parent" {
			t.Fatalf("REST父目录错误不明确：%d %s", w.Code, w.Body.String())
		}
	}
}
