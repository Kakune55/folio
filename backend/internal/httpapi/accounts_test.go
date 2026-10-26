package httpapi

import (
	"bytes"
	"encoding/json"
	"folio/internal/auth"
	"folio/internal/config"
	"folio/internal/storage"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"
)

func TestAccountsIsolationManagementAndQuota(t *testing.T) {
	base := t.TempDir()
	workspace := filepath.Join(base, "workspace")
	data := filepath.Join(base, "data")
	os.Mkdir(workspace, 0700)
	os.Mkdir(data, 0700)
	accounts, err := auth.Open(data, "admin-password-12345")
	if err != nil {
		t.Fatal(err)
	}
	defer accounts.Close()
	handler, err := NewAccounts(fstest.MapFS{"index.html": {Data: []byte("<html>Folio</html>")}}, config.Config{Workspace: workspace, AppData: data, Limits: storage.DefaultLimits, IndexLimit: 1 << 20}, accounts)
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()
	server := httptest.NewServer(handler)
	defer server.Close()
	type login struct {
		Token       string
		Principal   auth.Principal
		WorkspaceID string
	}
	call := func(user login, method, path string, body any, headers map[string]string) (int, []byte) {
		var reader io.Reader
		if body != nil {
			encoded, _ := json.Marshal(body)
			reader = bytes.NewReader(encoded)
		}
		request, _ := http.NewRequest(method, server.URL+"/api/v1"+path, reader)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-CSRF-Token", user.Principal.CSRF)
		if user.WorkspaceID != "" {
			request.Header.Set("X-Folio-Workspace", user.WorkspaceID)
		}
		if user.Token != "" {
			request.AddCookie(&http.Cookie{Name: cookieName, Value: user.Token})
		}
		for k, v := range headers {
			request.Header.Set(k, v)
		}
		response, err := server.Client().Do(request)
		if err != nil {
			t.Error(err)
			return 0, nil
		}
		defer response.Body.Close()
		content, _ := io.ReadAll(response.Body)
		return response.StatusCode, content
	}
	signIn := func(name, password string) login {
		token, p, e := accounts.Login(name, password, "", name)
		if e != nil {
			t.Fatal(e)
		}
		id, e := handler.options().WorkspaceFor(p.ID)
		if e != nil {
			t.Fatal(e)
		}
		return login{token, *p, id}
	}
	admin := signIn("admin", "admin-password-12345")
	create := func(name string) login {
		status, body := call(admin, "POST", "/admin/users", auth.UserInput{Username: name, Enabled: true, Quota: 20, Password: "user-password-12345"}, nil)
		if status != 201 {
			t.Fatalf("创建：%d %s", status, body)
		}
		return signIn(name, "user-password-12345")
	}
	alice, bob := create("alice"), create("bob")
	aliceEntry, err := handler.get(alice.Principal.ID)
	if err != nil {
		t.Fatal(err)
	}
	bobEntry, err := handler.get(bob.Principal.ID)
	if err != nil {
		t.Fatal(err)
	}
	if aliceEntry.events == bobEntry.events {
		t.Fatal("不同账号共用了通知通道")
	}
	ownEvents, err := aliceEntry.events.subscribe()
	if err != nil {
		t.Fatal(err)
	}
	bobEntry.events.publish(&changeSource{Name: "Bob 应用"}, "bob-only.txt")
	select {
	case <-ownEvents:
		t.Fatal("其他账号事件进入本人通知")
	default:
	}
	aliceEntry.events.unsubscribe(ownEvents)
	if alice.WorkspaceID == bob.WorkspaceID {
		t.Fatal("工作区身份相同")
	}
	for _, u := range []login{admin, alice, bob} {
		status, body := call(u, "POST", "/files", map[string]string{"path": "same.txt", "content": u.Principal.Username}, nil)
		if status != 201 {
			t.Fatalf("创建文件：%d %s", status, body)
		}
	}
	for _, u := range []login{admin, alice, bob} {
		status, body := call(u, "GET", "/files/content?path=same.txt", nil, nil)
		var file storage.Content
		json.Unmarshal(body, &file)
		if status != 200 || file.Content != u.Principal.Username {
			t.Fatalf("正文串账号：%d %s", status, body)
		}
	}
	for _, path := range []string{"/admin/users", "/files/content?path=../1/same.txt"} {
		status, _ := call(alice, "GET", path, nil, nil)
		if status != 403 && status != 400 {
			t.Fatalf("隔离失败：%s %d", path, status)
		}
	}
	if status, _ := call(alice, "GET", "/files/content?path=same.txt", nil, map[string]string{"X-Folio-Workspace": bob.WorkspaceID}); status != 409 {
		t.Fatal("未拒绝错误工作区身份")
	}
	if status, _ := call(alice, "POST", "/admin/users", auth.UserInput{Username: "evil", Enabled: true, Quota: 20, Password: "user-password-12345"}, nil); status != 403 {
		t.Fatal("普通用户创建账号")
	}

	// 下载和搜索也按账号隔离，不借用全局索引。
	if status, body := call(alice, "GET", "/files/download?path=same.txt", nil, nil); status != 200 || string(body) != "alice" {
		t.Fatal("下载串账号", status, string(body))
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		_, body := call(bob, "GET", "/search?q=bob", nil, nil)
		if strings.Contains(string(body), "same.txt") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("搜索索引未完成", string(body))
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status, body := call(alice, "GET", "/search?q=bob", nil, nil); status != 200 || strings.Contains(string(body), "same.txt") {
		t.Fatal("跨账号搜索泄露", status, string(body))
	}
	// 并发创建只能有一个提交成功，旧文件与失败上传不得丢失。
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for _, name := range []string{"one.txt", "two.txt"} {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			status, _ := call(alice, "POST", "/files", map[string]string{"path": name, "content": strings.Repeat("x", 10)}, nil)
			statuses <- status
		}(name)
	}
	wg.Wait()
	close(statuses)
	success := 0
	for status := range statuses {
		if status == 201 {
			success++
		} else if status != 413 {
			t.Fatalf("配额并发：%d", status)
		}
	}
	if success != 1 {
		t.Fatal("配额被并发突破")
	}
	status, body := call(alice, "GET", "/files/content?path=same.txt", nil, nil)
	var file storage.Content
	json.Unmarshal(body, &file)
	if status != 200 {
		t.Fatal(string(body))
	}
	status, body = call(alice, "DELETE", "/entries?path=same.txt", nil, map[string]string{"If-Match": "\"" + file.Revision + "\""})
	if status != 200 {
		t.Fatalf("回收：%d %s", status, body)
	}
	var record struct {
		ID string `json:"id"`
	}
	json.Unmarshal(body, &record)
	_, body = call(alice, "GET", "/workspace/usage", nil, nil)
	var usage storage.Usage
	json.Unmarshal(body, &usage)
	if usage.Used != 15 {
		t.Fatalf("回收站未计费：%s", body)
	}
	if status, _ = call(bob, "POST", "/trash/"+record.ID+"/restore", nil, nil); status < 400 {
		t.Fatal("跨账号恢复")
	}
	if status, body = call(alice, "DELETE", "/trash/"+record.ID, nil, nil); status != 200 {
		t.Fatalf("永久删除：%d %s", status, body)
	}
	_, body = call(alice, "GET", "/workspace/usage", nil, nil)
	json.Unmarshal(body, &usage)
	if usage.Used != 10 {
		t.Fatal("永久删除未释放用量")
	}
	// 管理员不能自禁用；账号改名不改变工作区。
	if status, _ = call(admin, "PATCH", "/admin/users/1", auth.UserInput{Username: "admin", Quota: 100, Enabled: false}, nil); status != 400 {
		t.Fatal("允许禁用管理员")
	}
	aliceID := alice.Principal.ID
	status, body = call(admin, "PATCH", "/admin/users/"+strings.TrimSpace(string(mustJSON(aliceID))), auth.UserInput{Username: "alice-renamed", Enabled: true, Quota: 5}, nil)
	if status != 200 {
		t.Fatalf("改名限额：%d %s", status, body)
	}
	if id, _ := handler.options().WorkspaceFor(aliceID); id != alice.WorkspaceID {
		t.Fatal("改名改变工作区")
	}
	if status, _ = call(alice, "POST", "/files", map[string]string{"path": "blocked.txt", "content": "x"}, nil); status != 413 {
		t.Fatal("超额仍能新增")
	}
	_, body = call(alice, "GET", "/files/content?path=one.txt", nil, nil)
	json.Unmarshal(body, &file)
	// 选择实际成功的并发文件。
	if file.Path != "one.txt" {
		_, body = call(alice, "GET", "/files/content?path=two.txt", nil, nil)
		json.Unmarshal(body, &file)
	}
	if status, body = call(alice, "PUT", "/files/content?path="+file.Path, map[string]string{"content": "x"}, map[string]string{"If-Match": "\"" + file.Revision + "\""}); status != 200 {
		t.Fatalf("超额缩小失败：%d %s", status, body)
	}
	status, body = call(admin, "PATCH", "/admin/users/"+string(mustJSON(bob.Principal.ID)), auth.UserInput{Username: "bob", Enabled: false, Quota: 20}, nil)
	if status != 200 {
		t.Fatal(string(body))
	}
	if status, _ = call(bob, "GET", "/workspace/tree", nil, nil); status != 401 {
		t.Fatal("禁用会话仍有效")
	}
	if status, _ = call(alice, "POST", "/auth/password", map[string]string{"oldPassword": "wrong", "newPassword": "new-password-12345"}, nil); status != 403 {
		t.Fatal("原密码未验证")
	}
	if status, body = call(alice, "POST", "/auth/password", map[string]string{"oldPassword": "user-password-12345", "newPassword": "new-password-12345"}, nil); status != 200 {
		t.Fatalf("自助改密：%d %s", status, body)
	}
	if status, _ = call(alice, "GET", "/workspace/tree", nil, nil); status != 401 {
		t.Fatal("改密旧会话仍有效")
	}
	next := signIn("alice-renamed", "new-password-12345")
	if next.WorkspaceID != alice.WorkspaceID {
		t.Fatal("改密丢失草稿身份")
	}
	response, err := server.Client().Get(server.URL + "/system-setting")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("系统设置直达失败")
	}
}
func mustJSON(value any) []byte { data, _ := json.Marshal(value); return data }
