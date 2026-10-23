package httpapi

import (
	"bytes"
	"encoding/json"
	"folio/internal/auth"
	"folio/internal/config"
	"folio/internal/sharing"
	"folio/internal/storage"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func TestShareHTTPBoundaries(t *testing.T) {
	base := t.TempDir()
	workspace := filepath.Join(base, "workspace")
	data := filepath.Join(base, "data")
	os.Mkdir(workspace, 0700)
	os.Mkdir(data, 0700)
	accounts, e := auth.Open(data, "share-test-password-123")
	if e != nil {
		t.Fatal(e)
	}
	defer accounts.Close()
	h, e := NewAccounts(fstest.MapFS{"index.html": {Data: []byte("Folio")}}, config.Config{Workspace: workspace, AppData: data, Limits: storage.DefaultLimits, IndexLimit: 1 << 20}, accounts)
	if e != nil {
		t.Fatal(e)
	}
	defer h.Close()
	ownerToken, p, e := accounts.Login("admin", "share-test-password-123", "", "owner")
	if e != nil {
		t.Fatal(e)
	}
	entry, e := h.get(p.ID)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = entry.store.Write("note.md", "# 正文\n[文件](file.txt)\n", "", true); e != nil {
		t.Fatal(e)
	}
	entry.store.Write("file.txt", "附件", "", true)
	call := func(method, url string, body any, login, grant, origin string) *httptest.ResponseRecorder {
		var b bytes.Buffer
		if body != nil {
			json.NewEncoder(&b).Encode(body)
		}
		r := httptest.NewRequest(method, url, &b)
		r.Header.Set("Content-Type", "application/json")
		if login != "" {
			r.AddCookie(&http.Cookie{Name: cookieName, Value: login})
			current, err := accounts.Authenticate(login)
			if err != nil {
				t.Fatal(err)
			}
			target, err := h.get(current.ID)
			if err != nil {
				t.Fatal(err)
			}
			r.Header.Set("X-CSRF-Token", current.CSRF)
			r.Header.Set("X-Folio-Workspace", target.id)
		}
		if grant != "" {
			r.Header.Add("Cookie", grant)
		}
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	scan, e := sharing.ScanFiles(entry.store, "note.md", true)
	if e != nil {
		t.Fatal(e)
	}
	in := sharing.Input{Root: "note.md", Title: "分享", Mode: "live", Files: scan.Files}
	if w := call("POST", "/api/v1/shares", in, ownerToken, "", ""); w.Code != 400 {
		t.Fatal("实时附件未拒绝", w.Code, w.Body.String())
	}
	in.Mode = "snapshot"
	password := "000123"
	in.Password = &password
	in.MaxVisits = 2
	w := call("POST", "/api/v1/shares", in, ownerToken, "", "")
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var record sharing.Record
	json.Unmarshal(w.Body.Bytes(), &record)
	url := "/api/v1/public/shares/" + record.ID
	file := url + "/files/" + record.Files[0].ID
	for _, method := range []string{"GET", "HEAD"} {
		w = call(method, file+"/download", nil, "", "", "")
		if w.Code != 403 {
			t.Fatal("匿名绕过密码", w.Code)
		}
	}
	w = call("POST", url+"/enter", map[string]string{"password": password}, "", "", "https://evil.invalid")
	if w.Code != 403 {
		t.Fatal("跨源进入未拒绝")
	}
	w = call("POST", url+"/enter", map[string]string{"password": password}, "", "", "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatal(cookies)
	}
	grant := cookies[0].Name + "=" + cookies[0].Value
	w = call("GET", file+"/content", nil, "", grant, "")
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(w.Code, w.Body.String())
	}
	w = call("GET", url+"/files/unknown/download", nil, "", grant, "")
	if w.Code != 404 {
		t.Fatal("读取清单外文件", w.Code)
	}
	w = call("POST", "/api/v1/shares/"+record.ID+"/import", map[string]string{"file": record.Files[0].ID, "directory": "收到"}, "", grant, "")
	if w.Code != 401 {
		t.Fatal("匿名转存", w.Code)
	}
	w = call("POST", "/api/v1/shares/"+record.ID+"/import", map[string]string{"file": record.Files[0].ID, "directory": "../越界"}, ownerToken, grant, "")
	if w.Code != 400 {
		t.Fatal("越界转存", w.Code, w.Body.String())
	}
	w = call("POST", "/api/v1/shares/"+record.ID+"/import", map[string]string{"file": record.Files[0].ID, "directory": "收到"}, ownerToken, grant, "")
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = call("GET", "/api/v1/shares", nil, "", grant, "")
	if w.Code != 401 {
		t.Fatal("访客管理分享", w.Code)
	}
	w = call("GET", "/s/"+record.ID, nil, "", "", "")
	if w.Code != 200 || w.Header().Get("X-Robots-Tag") == "" {
		t.Fatal("公开页面路由", w.Code)
	}
	other, e := accounts.SaveUser(0, auth.UserInput{Username: "receiver", Password: "receiver-password-123", Enabled: true, Quota: 1 << 20})
	if e != nil {
		t.Fatal(e)
	}
	otherToken, _, e := accounts.Login(other.Username, "receiver-password-123", "", "receiver")
	if e != nil {
		t.Fatal(e)
	}
	w = call("GET", "/api/v1/shares", nil, otherToken, "", "")
	if w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte(`"entries":[]`)) {
		t.Fatal("他人可见分享管理", w.Code, w.Body.String())
	}
	w = call("DELETE", "/api/v1/shares/"+record.ID, nil, otherToken, "", "")
	if w.Code != 404 {
		t.Fatal("跨用户删除分享", w.Code)
	}
	// 缺少 CSRF 不允许写接收工作区。
	request := httptest.NewRequest("POST", "/api/v1/shares/"+record.ID+"/import", bytes.NewBufferString(`{"file":"`+record.Files[0].ID+`","directory":"伪造"}`))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(&http.Cookie{Name: cookieName, Value: ownerToken})
	request.Header.Add("Cookie", grant)
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != 403 {
		t.Fatal("无 CSRF 转存", response.Code)
	}
	// 修改访问设置使旧授权失效；陈旧管理页不能撤销后再次开启。
	in.Files = nil
	in.Version = record.Version
	in.Disabled = true
	w = call("PUT", "/api/v1/shares/"+record.ID, in, ownerToken, "", "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = call("GET", file+"/download", nil, "", grant, "")
	if w.Code != 410 {
		t.Fatal("撤销后授权仍有效", w.Code)
	}
	in.Disabled = false
	w = call("PUT", "/api/v1/shares/"+record.ID, in, ownerToken, "", "")
	if w.Code != 409 {
		t.Fatal("接受陈旧分享设置", w.Code, w.Body.String())
	}
}
