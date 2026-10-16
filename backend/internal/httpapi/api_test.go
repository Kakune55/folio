package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"folio/internal/auth"
	"folio/internal/storage"
)

func TestAuthenticatedFileFlow(t *testing.T) {
	root := t.TempDir()
	store, err := storage.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	appData := filepath.Join(t.TempDir(), "app-data")
	if err = os.Mkdir(appData, 0o700); err != nil {
		t.Fatal(err)
	}
	accounts, err := auth.Open(appData, "测试用的足够长密码-123")
	if err != nil {
		t.Fatal(err)
	}
	defer accounts.Close()
	handler := New(fstest.MapFS{}, Options{Auth: accounts, Workspace: store, WorkspaceID: "当前工作区", SecureCookie: true, Origin: "https://folio.example"})
	var cookie *http.Cookie
	csrf := ""
	call := func(method, url, body, etag string, withCSRF bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, url, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", "https://folio.example")
		if cookie != nil {
			r.AddCookie(cookie)
		}
		if withCSRF {
			r.Header.Set("X-CSRF-Token", csrf)
		}
		if etag != "" {
			r.Header.Set("If-Match", etag)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	assertStatus := func(w *httptest.ResponseRecorder, status int) {
		t.Helper()
		if w.Code != status {
			t.Fatalf("预期 %d，得到 %d %s", status, w.Code, w.Body.String())
		}
	}
	assertStatus(call("GET", "/api/v1/workspace/tree", "", "", false), 401)
	login := call("POST", "/api/v1/auth/login", `{"username":"admin","password":"测试用的足够长密码-123"}`, "", false)
	assertStatus(login, 200)
	cookie = login.Result().Cookies()[0]
	if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatal("会话 Cookie 不安全")
	}
	var principal auth.Principal
	if err = json.Unmarshal(login.Body.Bytes(), &principal); err != nil {
		t.Fatal(err)
	}
	csrf = principal.CSRF
	assertStatus(call("POST", "/api/v1/directories", `{"path":"笔记"}`, "", false), 403)
	assertStatus(call("POST", "/api/v1/directories", `{"path":"笔记"}`, "", true), 201)
	create := call("POST", "/api/v1/files", `{"path":"笔记/你好.md","content":"# 你好\n"}`, "", true)
	assertStatus(create, 201)
	assertStatus(call("POST", "/api/v1/files", `{"path":"笔记/你好.md","content":"不得覆盖"}`, "", true), 409)
	read := call("GET", "/api/v1/files/content?path=笔记/你好.md", "", "", false)
	assertStatus(read, 200)
	etag := read.Header().Get("ETag")
	revision := call("GET", "/api/v1/files/revision?path=笔记/你好.md", "", "", false)
	assertStatus(revision, 200)
	if revision.Header().Get("ETag") != etag || strings.Contains(revision.Body.String(), `"content"`) {
		t.Fatal("版本检查必须与正文读取使用相同 ETag，但不传输正文")
	}
	assertStatus(call("GET", "/api/v1/files/revision?path=笔记", "", "", false), 415)
	assertStatus(call("PUT", "/api/v1/files/content?path=笔记/你好.md", `{"content":"缺少版本"}`, "", true), 428)
	assertStatus(call("PUT", "/api/v1/files/content?path=笔记/你好.md", `{"content":"# 保存成功\n"}`, etag, true), 200)
	assertStatus(call("PUT", "/api/v1/files/content?path=笔记/你好.md", `{"content":"陈旧写入"}`, etag, true), 412)
	wrongWorkspace := httptest.NewRequest("PUT", "/api/v1/files/content?path=笔记/你好.md", strings.NewReader(`{"content":"不能写到另一个工作区"}`))
	wrongWorkspace.AddCookie(cookie)
	wrongWorkspace.Header.Set("Origin", "https://folio.example")
	wrongWorkspace.Header.Set("X-CSRF-Token", csrf)
	wrongWorkspace.Header.Set("X-Folio-Workspace", "旧工作区")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, wrongWorkspace)
	assertStatus(response, 409)
	if !strings.Contains(response.Body.String(), "workspace_changed") {
		t.Fatal("未明确报告工作区切换")
	}
	bytesOnDisk, _ := os.ReadFile(filepath.Join(root, "笔记/你好.md"))
	if !bytes.Equal(bytesOnDisk, []byte("# 保存成功\n")) {
		t.Fatal("真实文件未正确保存")
	}
	assertStatus(call("GET", "/api/v1/files/content?path=../secret", "", "", false), 400)
	assertStatus(call("POST", "/api/v1/auth/logout", "", "", true), 200)
	assertStatus(call("GET", "/api/v1/auth/me", "", "", false), 401)
}
