package httpapi

import (
	"bytes"
	"encoding/json"
	"folio/internal/auth"
	"folio/internal/config"
	"folio/internal/storage"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func TestBearerAccessPermissionsIsolationAndConditions(t *testing.T) {
	base := t.TempDir()
	workspace := filepath.Join(base, "workspace")
	data := filepath.Join(base, "data")
	os.Mkdir(workspace, 0700)
	os.Mkdir(data, 0700)
	accounts, err := auth.Open(data, "admin-token-password-2026")
	if err != nil {
		t.Fatal(err)
	}
	defer accounts.Close()
	handler, err := NewAccounts(fstest.MapFS{"index.html": {Data: []byte("Folio")}}, config.Config{Workspace: workspace, AppData: data, Limits: storage.DefaultLimits, IndexLimit: 1 << 20}, accounts)
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()
	session, principal, err := accounts.Login("admin", "admin-token-password-2026", "", "local")
	if err != nil {
		t.Fatal(err)
	}
	call := func(method, url, secret string, body any, cookie bool, headers map[string]string) *httptest.ResponseRecorder {
		t.Helper()
		encoded, _ := json.Marshal(body)
		r := httptest.NewRequest(method, "/api/v1"+url, bytes.NewReader(encoded))
		r.Header.Set("Content-Type", "application/json")
		if secret != "" {
			r.Header.Set("Authorization", "Bearer "+secret)
		}
		if cookie {
			r.AddCookie(&http.Cookie{Name: cookieName, Value: session})
			r.Header.Set("X-CSRF-Token", principal.CSRF)
		}
		for key, value := range headers {
			r.Header.Set(key, value)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	check := func(w *httptest.ResponseRecorder, want int) {
		t.Helper()
		if w.Code != want {
			t.Fatalf("want %d got %d: %s", want, w.Code, w.Body.String())
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("响应可缓存")
		}
	}
	// 浏览器管理令牌仍要求 CSRF，访问令牌不能自我提升。
	r := httptest.NewRequest("POST", "/api/v1/user/tokens", bytes.NewBufferString(`{}`))
	r.Header.Set("Content-Type", "application/json")
	r.AddCookie(&http.Cookie{Name: cookieName, Value: session})
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	check(w, 403)
	create := func(perms auth.TokenPermissions) (int64, string) {
		t.Helper()
		w := call("POST", "/user/tokens", "", map[string]any{"name": "client", "expiresAt": 0, "permissions": perms}, true, nil)
		check(w, 201)
		var result struct {
			ID    int64  `json:"id"`
			Token string `json:"token"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result.ID, result.Token
	}
	id, read := create(auth.TokenPermissions{Files: "read", Search: "read", Trash: "none"})
	_, write := create(auth.TokenPermissions{Files: "write", Search: "none", Trash: "write"})
	w = call("POST", "/files", write, map[string]string{"path": "note.txt", "content": "admin"}, false, nil)
	check(w, 201)
	check(call("POST", "/files", read, map[string]string{"path": "denied.txt", "content": "bad"}, true, nil), 403)
	w = call("GET", "/files/content?path=note.txt", read, nil, false, nil)
	check(w, 200)
	var content storage.Content
	json.Unmarshal(w.Body.Bytes(), &content)
	for _, url := range []string{"/user/tokens", "/auth/me", "/admin/users", "/admin/settings", "/shares", "/trash"} {
		check(call("GET", url, read, nil, true, nil), 403)
	}
	check(call("POST", "/search/rebuild", read, nil, false, nil), 403)
	check(call("GET", "/search?q=admin", write, nil, false, nil), 403)
	check(call("GET", "/files/content?path=note.txt", "folio_"+string(bytes.Repeat([]byte("f"), 64)), nil, true, nil), 401)
	check(call("GET", "/files/content?path=note.txt", read, nil, true, map[string]string{"Authorization": "Basic abc"}), 401)
	check(call("GET", "/files/content?path=note.txt", read, nil, false, map[string]string{"X-Folio-Workspace": "other"}), 409)
	check(call("GET", "/files/content?path=../secret", read, nil, false, nil), 400)
	_, oldWorkspaceToken, err := accounts.CreateAccessToken(1, "previous-workspace", "旧工作区", 0, auth.TokenPermissions{Files: "read", Search: "none", Trash: "none"})
	if err != nil {
		t.Fatal(err)
	}
	check(call("GET", "/workspace/tree", oldWorkspaceToken, nil, false, nil), 409)

	check(call("PUT", "/files/content?path=note.txt", write, map[string]string{"content": "changed"}, false, nil), 428)
	header := map[string]string{"If-Match": "\"" + content.Revision + "\""}
	check(call("PUT", "/files/content?path=note.txt", write, map[string]string{"content": "changed"}, false, header), 200)
	check(call("PUT", "/files/content?path=note.txt", write, map[string]string{"content": "overwrite"}, false, header), 412)
	check(call("POST", "/files", write, map[string]string{"path": "note.txt", "content": "overwrite"}, false, nil), 409)
	check(call("DELETE", "/trash/nonexistent", write, nil, false, nil), 403)
	check(call("GET", "/workspace/storage", read, nil, false, nil), 200)
	// 相同路径按令牌所属用户分派，不能用查询参数或 Cookie 切换身份。
	user, err := accounts.SaveUser(0, auth.UserInput{Username: "alice", Enabled: true, Quota: 4, Password: "alice-token-password-2026"})
	if err != nil {
		t.Fatal(err)
	}
	entry, err := handler.get(user.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, alice, err := accounts.CreateAccessToken(user.ID, entry.id, "alice", 0, auth.TokenPermissions{Files: "write", Search: "read", Trash: "none"})
	if err != nil {
		t.Fatal(err)
	}
	check(call("GET", "/files/content?path=note.txt&user_id=1", alice, nil, true, nil), 404)
	check(call("POST", "/files", alice, map[string]string{"path": "note.txt", "content": "alice"}, false, nil), 413)
	check(call("POST", "/files", alice, map[string]string{"path": "note.txt", "content": "a"}, false, nil), 201)
	check(call("GET", "/files/content?path=note.txt", read, nil, false, nil), 200)
	check(call("DELETE", "/user/tokens/"+jsonNumber(id), "", nil, true, nil), 200)
	check(call("GET", "/workspace/tree", read, nil, true, nil), 401)
	// 不存在的、跨用户的令牌删除不暴露所有者。
	check(call("DELETE", "/user/tokens/99999", "", nil, true, nil), 404)
}
func jsonNumber(id int64) string { data, _ := json.Marshal(id); return string(data) }

func TestTokenRouteWhitelist(t *testing.T) {
	all := &auth.AccessToken{Permissions: auth.TokenPermissions{Files: "write", Search: "write", Trash: "write"}}
	for _, route := range []string{"GET /api/v1/admin/status", "POST /api/v1/auth/password", "GET /api/v1/user/tokens", "POST /api/v1/user/tokens", "DELETE /api/v1/trash/id", "POST /api/v1/shares", "POST /api/v1/shares/id/copy", "GET /api/v1/future"} {
		i := bytes.IndexByte([]byte(route), ' ')
		r := httptest.NewRequest(route[:i], route[i+1:], nil)
		if authorizeToken(all, r) {
			t.Fatal("越权", route)
		}
	}
	for _, route := range []string{"POST /api/v1/trash/id/restore", "DELETE /api/v1/entries?path=note.txt", "POST /api/v1/uploads", "GET /api/v1/files/download?path=note.txt"} {
		i := bytes.IndexByte([]byte(route), ' ')
		r := httptest.NewRequest(route[:i], route[i+1:], nil)
		if !authorizeToken(all, r) {
			t.Fatal("白名单遗漏", route)
		}
	}
	all.Permissions.Files = "read"
	if authorizeToken(all, httptest.NewRequest("POST", "/api/v1/trash/id/restore", nil)) {
		t.Fatal("恢复绕过文件只读")
	}
}
