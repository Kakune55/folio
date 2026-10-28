package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"folio/internal/auth"
	"folio/internal/storage"
)

func TestPathParameterLocationAndErrors(t *testing.T) {
	store, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	accounts, err := auth.Open(t.TempDir(), "path-test-password")
	if err != nil {
		t.Fatal(err)
	}
	defer accounts.Close()
	session, principal, err := accounts.Login("admin", "path-test-password", "", "local")
	if err != nil {
		t.Fatal(err)
	}
	_, bearer, err := accounts.CreateAccessToken(principal.ID, "path-test", "path-test", 0, auth.TokenPermissions{Files: "write", Search: "read", Trash: "write"})
	if err != nil {
		t.Fatal(err)
	}
	_, denied, err := accounts.CreateAccessToken(principal.ID, "path-test", "search-only", 0, auth.TokenPermissions{Files: "none", Search: "read", Trash: "none"})
	if err != nil {
		t.Fatal(err)
	}
	revision, err := store.Write("演示.md", "原始正文\n", "", true)
	if err != nil {
		t.Fatal(err)
	}
	handler := New(fstest.MapFS{}, Options{Auth: accounts, Workspace: store, WorkspaceID: "path-test", Origin: "https://folio.example"})
	call := func(method, target, body, credential, etag string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, target, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if credential == "cookie" {
			req.AddCookie(&http.Cookie{Name: cookieName, Value: session})
			req.Header.Set("Origin", "https://folio.example")
			req.Header.Set("X-CSRF-Token", principal.CSRF)
		} else if credential != "" {
			req.Header.Set("Authorization", "Bearer "+credential)
		}
		if etag != "" {
			req.Header.Set("If-Match", etag)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response
	}
	check := func(response *httptest.ResponseRecorder, code, expected string) {
		t.Helper()
		var body struct {
			Error struct {
				Code    string         `json:"code"`
				Message string         `json:"message"`
				Details map[string]any `json:"details"`
			} `json:"error"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err, response.Body.String())
		}
		if response.Code != 400 || body.Error.Code != code || body.Error.Message == "" {
			t.Fatal(response.Code, response.Body.String())
		}
		if expected != "" && body.Error.Details["expected"] != expected {
			t.Fatal("未说明参数位置", response.Body.String())
		}
		if _, exists := body.Error.Details["currentRevision"]; exists {
			t.Fatal("参数错误不应包含当前版本", response.Body.String())
		}
	}
	for _, credential := range []string{"cookie", bearer} {
		for _, endpoint := range []struct{ method, path string }{
			{"GET", "/files/content"}, {"HEAD", "/files/content"}, {"PUT", "/files/content"}, {"PATCH", "/files/content"},
			{"GET", "/files/revision"}, {"GET", "/files/metadata"}, {"GET", "/files/download"}, {"GET", "/files/preview"},
			{"GET", "/entries/revision"}, {"DELETE", "/entries"}, {"GET", "/search/file-status"},
		} {
			for _, query := range []string{"", "?path=", "?path", "?path=&path=演示.md"} {
				response := call(endpoint.method, "/api/v1"+endpoint.path+query, `{"path":"演示.md","content":"不得写入"}`, credential, "")
				check(response, "path_missing", "query:path")
			}
		}
		for _, endpoint := range []string{"/files", "/directories"} {
			bodies := []string{`{}`, `{"path":null}`, `{"path":""}`}
			if endpoint == "/files" {
				bodies = []string{`{}`, `{"content":"不得新建"}`, `{"path":null,"content":"不得新建"}`, `{"path":"","content":"不得新建"}`}
			}
			for _, body := range bodies {
				check(call("POST", "/api/v1"+endpoint+"?path=wrong.md", body, credential, ""), "path_missing", "body:path")
			}
			body := `{"path":42}`
			if endpoint == "/files" {
				body = `{"path":42,"content":"不得新建"}`
			}
			check(call("POST", "/api/v1"+endpoint, body, credential, ""), "invalid_request", "")
		}
		check(call("GET", "/api/v1/files/content?path=../outside.md", "", credential, ""), "path_invalid", "")
		check(call("GET", "/api/v1/files/content?path=%ZZ", "", credential, ""), "invalid_request", "query:path")
		for _, root := range []string{"/api/v1/workspace/tree", "/api/v1/workspace/tree?path="} {
			if response := call("GET", root, "", credential, ""); response.Code != 200 {
				t.Fatal("根目录语义改变", response.Code, response.Body.String())
			}
		}
		if response := call("PUT", "/api/v1/files/content?path=演示.md", `{"content":"缺少条件不得写入"}`, credential, ""); response.Code != 428 {
			t.Fatal("path 修正后仍须 If-Match", response.Code, response.Body.String())
		}
	}
	if response := call("PUT", "/api/v1/files/content", `{"content":"不得写入"}`, "", ""); response.Code != 401 {
		t.Fatal("参数验证绕过认证", response.Code, response.Body.String())
	}
	if response := call("PUT", "/api/v1/files/content", `{"content":"不得写入"}`, denied, ""); response.Code != 403 {
		t.Fatal("参数验证绕过令牌权限", response.Code, response.Body.String())
	}
	content, err := store.Read("演示.md")
	if err != nil || content.Content != "原始正文\n" || content.Revision != revision {
		t.Fatal("失败请求修改了正文", content, err)
	}
	response := call("PUT", "/api/v1/files/content?path=演示.md", `{"content":"原始正文\n追加内容\n"}`, bearer, `"`+revision+`"`)
	if response.Code != 200 {
		t.Fatal("修正参数后无法条件保存", response.Code, response.Body.String())
	}
	content, err = store.Read("演示.md")
	if err != nil || content.Content != "原始正文\n追加内容\n" {
		t.Fatal(content, err)
	}
	response = call("PUT", "/api/v1/files/content?path=演示.md", `{"content":"陈旧正文"}`, bearer, `"`+revision+`"`)
	if response.Code != 412 || !strings.Contains(response.Body.String(), content.Revision) || !strings.Contains(response.Body.String(), "currentRevision") {
		t.Fatal("真实冲突仍应提供当前版本", response.Code, response.Body.String())
	}
}
