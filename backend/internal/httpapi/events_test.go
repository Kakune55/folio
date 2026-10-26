package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"folio/internal/auth"
	"folio/internal/storage"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func TestChangeHubBoundedAndIsolated(t *testing.T) {
	hub, other := newChangeHub(), newChangeHub()
	channel, _ := hub.subscribe()
	different, _ := other.subscribe()
	hub.publish(&changeSource{Name: "应用一"}, "note.txt")
	hub.publish(&changeSource{Name: "应用二"}, "next.txt")
	if change := <-channel; !change.Reset || change.Source != nil {
		t.Fatal("慢连接未改为完整核对")
	}
	select {
	case <-different:
		t.Fatal("跨工作区通知泄露")
	default:
	}
	for i := 0; i < 3; i++ {
		if _, err := hub.subscribe(); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := hub.subscribe(); err == nil {
		t.Fatal("未限制连接数")
	}
	hub.unsubscribe(channel)
	if _, err := hub.subscribe(); err != nil {
		t.Fatal("取消订阅未释放连接")
	}
	hub.close()
	hub.close()
	select {
	case <-hub.done:
	default:
		t.Fatal("关闭未通知连接")
	}
	if _, err := hub.subscribe(); err == nil {
		t.Fatal("关闭后仍可订阅")
	}
}

func TestChangeSourceResetAndUncertainResult(t *testing.T) {
	hub := newChangeHub()
	channel, _ := hub.subscribe()
	r := withChangeSource(httptest.NewRequest("POST", "/", nil), "中文 <应用>\n名称")
	a := &api{Options: Options{Events: hub}}
	a.indexChange(r, nil, "note.txt")
	if event := <-channel; event.Source == nil || event.Source.Name != "中文 <应用>\n名称" {
		t.Fatal(event)
	}
	a.indexChange(r, &storage.Error{Code: "durability_uncertain"}, "note.txt")
	if event := <-channel; event.Source != nil || event.Reset {
		t.Fatal("不确定提交错误带来源", event)
	}
	a.indexChange(r, nil)
	if event := <-channel; !event.Reset || event.Source != nil {
		t.Fatal("reset 带来源", event)
	}
	a.indexChange(r, &storage.Error{Code: "revision_conflict"}, "note.txt")
	select {
	case event := <-channel:
		t.Fatal("拒绝写入仍发事件", event)
	default:
	}
}
func TestSSECookieScopeWriteDeadlineAndRevocation(t *testing.T) {
	store, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	accounts, err := auth.Open(t.TempDir(), "events-password-2026")
	if err != nil {
		t.Fatal(err)
	}
	defer accounts.Close()
	session, p, err := accounts.Login("admin", "events-password-2026", "", "local")
	if err != nil {
		t.Fatal(err)
	}
	hub := newChangeHub()
	defer hub.close()
	handler := New(fstest.MapFS{}, Options{Auth: accounts, Workspace: store, WorkspaceID: "workspace-one", OwnerID: 1, Events: hub})
	server := httptest.NewUnstartedServer(handler)
	server.Config.WriteTimeout = 50 * time.Millisecond
	server.Start()
	defer server.Close()
	client := server.Client()
	client.Timeout = 3 * time.Second
	request := func(method, path, body string, authorized bool, headers map[string]string) *http.Response {
		t.Helper()
		req, _ := http.NewRequest(method, server.URL+"/api/v1"+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if authorized {
			req.AddCookie(&http.Cookie{Name: cookieName, Value: session})
			req.Header.Set("X-CSRF-Token", p.CSRF)
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	for _, test := range []struct {
		path    string
		cookie  bool
		headers map[string]string
		status  int
	}{
		{"/workspace/events", false, nil, 401},
		{"/workspace/events?workspace=other", true, nil, 409},
		{"/workspace/events", true, map[string]string{"Origin": "https://other.invalid"}, 403},
	} {
		resp := request("GET", test.path, "", test.cookie, test.headers)
		resp.Body.Close()
		if resp.StatusCode != test.status {
			t.Fatal(resp.StatusCode)
		}
	}
	_, bearer, err := accounts.CreateAccessToken(1, "workspace-one", "app", 0, auth.TokenPermissions{Files: "write", Search: "write", Trash: "write"})
	if err != nil {
		t.Fatal(err)
	}
	denied := request("GET", "/workspace/events", "", true, map[string]string{"Authorization": "Bearer " + bearer})
	denied.Body.Close()
	if denied.StatusCode != 403 {
		t.Fatal("令牌可订阅浏览器通知", denied.StatusCode)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", server.URL+"/api/v1/workspace/events?workspace=workspace-one", nil)
	req.AddCookie(&http.Cookie{Name: cookieName, Value: session})
	stream, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	if !strings.HasPrefix(stream.Header.Get("Content-Type"), "text/event-stream") || stream.Header.Get("Cache-Control") != "no-store" || stream.Header.Get("X-Accel-Buffering") != "no" {
		t.Fatal(stream.Header)
	}
	reader := bufio.NewReader(stream.Body)
	next := func() (string, workspaceChange) {
		t.Helper()
		kind, data := "", ""
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				t.Fatal(err)
			}
			line = strings.TrimSuffix(line, "\n")
			if line == "" && kind != "" {
				break
			}
			if strings.HasPrefix(line, "event: ") {
				kind = strings.TrimPrefix(line, "event: ")
			}
			if strings.HasPrefix(line, "data: ") {
				data = strings.TrimPrefix(line, "data: ")
			}
		}
		var change workspaceChange
		if err := json.Unmarshal([]byte(data), &change); err != nil {
			t.Fatal(err)
		}
		return kind, change
	}
	kind, initial := next()
	if kind != "resync" || !initial.Reset {
		t.Fatal(kind, initial)
	}
	time.Sleep(80 * time.Millisecond)
	made := request("POST", "/files", `{"path":"note.txt","content":"a\n"}`, true, nil)
	bytes, err := io.ReadAll(made.Body)
	made.Body.Close()
	if err != nil || made.StatusCode != 201 {
		t.Fatal(made.StatusCode, string(bytes), err)
	}
	kind, changed := next()
	if kind != "change" || len(changed.Paths) != 1 || changed.Paths[0] != "note.txt" || changed.Source != nil {
		t.Fatal(kind, changed)
	}
	var saved struct {
		Revision string `json:"revision"`
	}
	json.Unmarshal(bytes, &saved)
	for _, test := range []struct {
		method, path, body string
		status             int
	}{
		{"PUT", "/files/content?path=note.txt", `{"content":"b\n"}`, 200},
		{"PATCH", "/files/content?path=note.txt", `{"diff":"@@ -1 +1 @@\n-b\n+c\n"}`, 200},
		{"POST", "/directories", `{"path":"token-dir"}`, 201},
		{"POST", "/files", `{"path":"token.txt","content":"token"}`, 201},
	} {
		resp := request(test.method, test.path, test.body, true, map[string]string{
			"Authorization": "Bearer " + bearer, "If-Match": "\"" + saved.Revision + "\"", "X-Folio-Source": "伪造名称",
		})
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != test.status {
			t.Fatalf("%s: %d %s", test.path, resp.StatusCode, body)
		}
		kind, event := next()
		encoded, _ := json.Marshal(event)
		if kind != "change" || event.Source == nil || event.Source.Name != "app" {
			t.Fatal("未使用已验证名称", kind, event)
		}
		var fields map[string]json.RawMessage
		json.Unmarshal(encoded, &fields)
		if string(fields["source"]) != `{"name":"app"}` || strings.Contains(string(encoded), bearer) {
			t.Fatal("来源泄露其他令牌属性", string(encoded))
		}
		if test.method == "PUT" || test.method == "PATCH" {
			json.Unmarshal(body, &saved)
		}
	}
	tap, _ := hub.subscribe()
	defer hub.unsubscribe(tap)
	preview := request("PATCH", "/files/content?path=note.txt", `{"diff":"@@ -1 +1 @@\n-c\n+d\n","dryRun":true}`, true, map[string]string{"If-Match": "\"" + saved.Revision + "\""})
	preview.Body.Close()
	if preview.StatusCode != 200 {
		t.Fatal(preview.StatusCode)
	}
	select {
	case <-tap:
		t.Fatal("dryRun 发出了变更通知")
	default:
	}
	directory := request("POST", "/directories", `{"path":"new-dir"}`, true, nil)
	directory.Body.Close()
	if directory.StatusCode != 201 {
		t.Fatal(directory.StatusCode)
	}
	kind, changed = next()
	if kind != "change" || changed.Paths[0] != "new-dir" {
		t.Fatal(kind, changed)
	}
	if err = accounts.Logout(session); err != nil {
		t.Fatal(err)
	}
	hub.publish(&changeSource{Name: "不可泄露"}, "must-not-leak.txt")
	kind, changed = next()
	if kind != "auth" || len(changed.Paths) != 0 {
		t.Fatal("撤销会话后泄露变更", kind, changed)
	}
}
