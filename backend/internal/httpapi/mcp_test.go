package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"folio/internal/auth"
	"folio/internal/config"
	"folio/internal/storage"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpTestEnv struct {
	t         *testing.T
	accounts  *auth.Service
	handler   *Accounts
	workspace string
	cookie    string
}

func newMCPTestEnv(t *testing.T, origin string) *mcpTestEnv {
	t.Helper()
	base := t.TempDir()
	workspace, data := filepath.Join(base, "workspace"), filepath.Join(base, "data")
	for _, dir := range []string{workspace, data} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	accounts, err := auth.Open(data, "mcp-admin-password-2026")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { accounts.Close() })
	handler, err := NewAccounts(fstest.MapFS{"index.html": {Data: []byte("Folio")}}, config.Config{Workspace: workspace, AppData: data, Limits: storage.DefaultLimits, IndexLimit: 1 << 20, Origin: origin}, accounts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { handler.Close() })
	cookie, _, err := accounts.Login("admin", "mcp-admin-password-2026", "", "local")
	if err != nil {
		t.Fatal(err)
	}
	return &mcpTestEnv{t: t, accounts: accounts, handler: handler, workspace: workspace, cookie: cookie}
}

func (e *mcpTestEnv) token(userID int64, permissions auth.TokenPermissions) (auth.AccessToken, string) {
	e.t.Helper()
	entry, err := e.handler.get(userID)
	if err != nil {
		e.t.Fatal(err)
	}
	token, secret, err := e.accounts.CreateAccessToken(userID, entry.id, "MCP 测试", 0, permissions)
	if err != nil {
		e.t.Fatal(err)
	}
	return token, secret
}

// 每个调用都是独立 HTTP 请求，不保存 MCP 会话或复用已认证身份。
func (e *mcpTestEnv) request(secret, method string, params any, change func(*http.Request)) *httptest.ResponseRecorder {
	e.t.Helper()
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	if err != nil {
		e.t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "http://localhost/mcp", bytes.NewReader(body))
	r.RemoteAddr = "127.0.0.1:12345"
	r = r.WithContext(context.WithValue(r.Context(), http.LocalAddrContextKey, &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 80}))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "application/json, text/event-stream")
	r.Header.Set("MCP-Protocol-Version", "2025-11-25")
	if secret != "" {
		r.Header.Set("Authorization", "Bearer "+secret)
	}
	if change != nil {
		change(r)
	}
	w := httptest.NewRecorder()
	e.handler.ServeHTTP(w, r)
	return w
}

type mcpTestResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *struct {
		Code int `json:"code"`
	} `json:"error"`
}

func (e *mcpTestEnv) rpc(secret, method string, params any) mcpTestResponse {
	e.t.Helper()
	w := e.request(secret, method, params, nil)
	if w.Code != http.StatusOK || !strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") {
		e.t.Fatalf("%s HTTP 响应异常：%d %s", method, w.Code, w.Body.String())
	}
	if w.Header().Get("Mcp-Session-Id") != "" {
		e.t.Fatal("无状态 MCP 不应签发会话")
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		e.t.Fatal("MCP 响应不应被缓存")
	}
	var response mcpTestResponse
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		e.t.Fatalf("%s 不是 JSON-RPC 响应：%v %s", method, err, w.Body.String())
	}
	if response.JSONRPC != "2.0" || response.ID != 1 {
		e.t.Fatalf("JSON-RPC 信封异常：%s", w.Body.String())
	}
	return response
}

type mcpTestToolResult struct {
	IsError           bool            `json:"isError"`
	StructuredContent json.RawMessage `json:"structuredContent"`
	Content           []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

func (e *mcpTestEnv) tool(secret, name string, arguments any) (mcpTestResponse, mcpTestToolResult) {
	e.t.Helper()
	response := e.rpc(secret, "tools/call", map[string]any{"name": name, "arguments": arguments})
	var result mcpTestToolResult
	if response.Error == nil {
		if err := json.Unmarshal(response.Result, &result); err != nil {
			e.t.Fatal(err)
		}
	}
	return response, result
}

func (e *mcpTestEnv) success(secret, name string, arguments any, target any) {
	e.t.Helper()
	response, result := e.tool(secret, name, arguments)
	if response.Error != nil || result.IsError || len(result.StructuredContent) == 0 || string(result.StructuredContent) == "null" {
		e.t.Fatalf("%s 调用失败：%s，JSON-RPC 错误：%+v", name, response.Result, response.Error)
	}
	if target != nil {
		if err := json.Unmarshal(result.StructuredContent, target); err != nil {
			e.t.Fatalf("%s structuredContent 无效：%v", name, err)
		}
	}
}

func (e *mcpTestEnv) failure(secret, name string, arguments any, code string, schemaAllowed bool) {
	e.t.Helper()
	response, result := e.tool(secret, name, arguments)
	if response.Error != nil {
		if !schemaAllowed || response.Error.Code != -32602 {
			e.t.Fatalf("%s 应返回工具错误 %s，实际 JSON-RPC 错误：%+v", name, code, response.Error)
		}
		return
	}
	// SDK v1.8.0 的类型化工具将 Schema 错误作为文本工具错误返回。
	if schemaAllowed && result.IsError && len(result.StructuredContent) == 0 && len(result.Content) == 1 && result.Content[0].Type == "text" && strings.HasPrefix(result.Content[0].Text, `validating "arguments":`) {
		return
	}
	var problem struct {
		Error struct {
			Code    string          `json:"code"`
			Message string          `json:"message"`
			Details json.RawMessage `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(result.StructuredContent, &problem); err != nil {
		e.t.Fatal(err)
	}
	var details map[string]any
	if err := json.Unmarshal(problem.Error.Details, &details); err != nil || details == nil {
		e.t.Fatalf("%s 的业务错误 details 必须是对象：%s %v", name, result.StructuredContent, err)
	}
	if !result.IsError || problem.Error.Code != code || problem.Error.Message == "" || len(problem.Error.Details) == 0 {
		e.t.Fatalf("%s 应返回 isError 和结构化错误 %s：%s", name, code, response.Result)
	}
}

func TestMCPSearchFieldValidation(t *testing.T) {
	e := newMCPTestEnv(t, "")
	_, secret := e.token(1, auth.TokenPermissions{Files: "none", Search: "read", Trash: "none"})
	cases := []struct {
		query, mode       string
		limit             int
		field, constraint string
	}{
		{"换行", "names", 500, "limit", "1..200"},
		{"换行", "names", 0, "limit", "1..200"},
		{"换行", "bogus", 1, "mode", "names or empty"},
		{"", "", 1, "query", "non_blank"},
		{"", "names", 1, "query", "non_blank"},
		{" \t\n", "names", 1, "query", "non_blank"},
		{strings.Repeat("界", 201), "names", 1, "query", "at_most_200_characters"},
		{"a\x00b", "names", 1, "query", "utf8_without_nul"},
	}
	for _, tc := range cases {
		response, result := e.tool(secret, "searchFiles", map[string]any{"query": tc.query, "mode": tc.mode, "limit": tc.limit})
		var problem struct {
			Error struct {
				Code, Message string
				Status        int
				Details       map[string]any
			}
		}
		if err := json.Unmarshal(result.StructuredContent, &problem); err != nil {
			t.Fatal(err)
		}
		if response.Error != nil || !result.IsError || problem.Error.Code != "invalid_request" || problem.Error.Status != 400 || problem.Error.Message == "" || !reflect.DeepEqual(problem.Error.Details, map[string]any{"field": tc.field, "constraint": tc.constraint}) {
			t.Fatalf("字段校验不明确：%+v，实际 %s", tc, result.StructuredContent)
		}
	}
	listed := e.rpc(secret, "tools/list", map[string]any{})
	var tools struct {
		Tools []struct {
			Name, Description string
			InputSchema       json.RawMessage
		}
	}
	if err := json.Unmarshal(listed.Result, &tools); err != nil {
		t.Fatal(err)
	}
	if len(tools.Tools) != 1 || tools.Tools[0].Name != "searchFiles" || !strings.Contains(tools.Tools[0].Description, "不支持offset分页") || !strings.Contains(string(tools.Tools[0].InputSchema), "名称与路径") {
		t.Fatalf("搜索能力描述不准确：%s", listed.Result)
	}
}

func TestRESTSearchFieldValidationAndEmptyCompatibility(t *testing.T) {
	e := newMCPTestEnv(t, "")
	_, secret := e.token(1, auth.TokenPermissions{Files: "none", Search: "read", Trash: "none"})
	for _, tc := range []struct{ query, field, constraint string }{
		{"q=x&limit=500", "limit", "1..200"},
		{"q=x&limit=invalid", "limit", "1..200"},
		{"q=x&mode=bogus", "mode", "names or empty"},
		{"q=%00", "q", "utf8_without_nul"},
		{"q=" + strings.Repeat("x", 201), "q", "at_most_200_characters"},
		{"q=&mode=names", "", ""},
		{"q=", "", ""},
	} {
		r := httptest.NewRequest("GET", "/api/v1/search?"+tc.query, nil)
		r.Header.Set("Authorization", "Bearer "+secret)
		w := httptest.NewRecorder()
		e.handler.ServeHTTP(w, r)
		if tc.field == "" {
			if w.Code != 200 {
				t.Fatalf("破坏浏览器空查询行为：%d %s", w.Code, w.Body.String())
			}
			continue
		}
		var problem struct {
			Error struct {
				Code    string
				Details map[string]any
			}
		}
		if err := json.Unmarshal(w.Body.Bytes(), &problem); err != nil {
			t.Fatal(err)
		}
		if w.Code != 400 || problem.Error.Code != "invalid_request" || !reflect.DeepEqual(problem.Error.Details, map[string]any{"field": tc.field, "constraint": tc.constraint}) {
			t.Fatalf("REST搜索字段错误：%s", w.Body.String())
		}
	}
}

func (e *mcpTestEnv) tools(secret string) []string {
	e.t.Helper()
	response := e.rpc(secret, "tools/list", map[string]any{})
	if response.Error != nil {
		e.t.Fatalf("tools/list 失败：%+v", response.Error)
	}
	var result struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(response.Result, &result); err != nil {
		e.t.Fatal(err)
	}
	names := make([]string, 0, len(result.Tools))
	for _, tool := range result.Tools {
		names = append(names, tool.Name)
	}
	sort.Strings(names)
	return names
}

func TestMCPInitializeAuthenticationAndOrigin(t *testing.T) {
	e := newMCPTestEnv(t, "")
	_, secret := e.token(1, auth.TokenPermissions{Files: "write", Search: "read", Trash: "write"})
	response := e.rpc(secret, "initialize", map[string]any{"protocolVersion": "2025-11-25", "capabilities": map[string]any{}, "clientInfo": map[string]string{"name": "folio-test", "version": "1"}})
	var initialized struct {
		ProtocolVersion string `json:"protocolVersion"`
		Instructions    string `json:"instructions"`
		Capabilities    struct {
			Tools json.RawMessage `json:"tools"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal(response.Result, &initialized); err != nil || response.Error != nil || initialized.ProtocolVersion != "2025-11-25" || len(initialized.Capabilities.Tools) == 0 {
		t.Fatalf("初始化失败：%s %v", response.Result, err)
	}
	for _, syntax := range []string{"Markdown/GFM", "mermaid", "KaTeX", "$...$", "独立$$行", "NOTE/TIP/IMPORTANT/WARNING/CAUTION", "图片使用相对路径", "未知语法保留原文"} {
		if !strings.Contains(initialized.Instructions, syntax) {
			t.Fatalf("MCP 初始化说明缺少语法提示：%s", syntax)
		}
	}
	if len(e.tools(secret)) != 14 {
		t.Fatal("完整权限应提供 14 项工具")
	}
	for _, tc := range []struct {
		name   string
		secret string
		status int
		change func(*http.Request)
	}{
		{"未认证", "", 401, nil},
		{"仅 Cookie", "", 401, func(r *http.Request) { r.AddCookie(&http.Cookie{Name: cookieName, Value: e.cookie}) }},
		{"URL 令牌", "", 401, func(r *http.Request) { r.URL.RawQuery = "access_token=" + secret + "&token=" + secret }},
		{"无效 Bearer 不回退", "folio_" + strings.Repeat("f", 64), 401, func(r *http.Request) { r.AddCookie(&http.Cookie{Name: cookieName, Value: e.cookie}) }},
		{"无效 Authorization 不回退", secret, 401, func(r *http.Request) {
			r.Header.Set("Authorization", "Basic abc")
			r.AddCookie(&http.Cookie{Name: cookieName, Value: e.cookie})
		}},
		{"跨站 Origin", secret, 403, func(r *http.Request) { r.Header.Set("Origin", "https://other.example") }},
		{"DNS 重绑定", secret, 403, func(r *http.Request) { r.Host = "attacker.example" }},
		{"工作区头不符", secret, 409, func(r *http.Request) { r.Header.Set("X-Folio-Workspace", "other") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := e.request(tc.secret, "tools/list", map[string]any{}, tc.change)
			if w.Code != tc.status {
				t.Fatalf("期望 HTTP %d，实际 %d：%s", tc.status, w.Code, w.Body.String())
			}
		})
	}
	w := e.request(secret, "tools/list", map[string]any{}, func(r *http.Request) { r.Header.Set("Origin", "http://localhost") })
	if w.Code != 200 {
		t.Fatalf("同源请求被拒绝：%d %s", w.Code, w.Body.String())
	}
	_, wrong, err := e.accounts.CreateAccessToken(1, "previous-workspace", "旧工作区", 0, auth.TokenPermissions{Files: "read", Search: "none", Trash: "none"})
	if err != nil {
		t.Fatal(err)
	}
	if w := e.request(wrong, "tools/list", map[string]any{}, nil); w.Code != 409 || !strings.Contains(w.Body.String(), "workspace_changed") {
		t.Fatalf("旧工作区令牌未拒绝：%d %s", w.Code, w.Body.String())
	}
}

func TestMCPExplicitOriginReverseProxy(t *testing.T) {
	e := newMCPTestEnv(t, "https://folio.example")
	_, secret := e.token(1, auth.TokenPermissions{Files: "read", Search: "none", Trash: "none"})
	for _, origin := range []string{"https://folio.example", "https://attacker.example"} {
		w := e.request(secret, "tools/list", map[string]any{}, func(r *http.Request) {
			r.Host = "folio.example"
			r.Header.Set("Origin", origin)
		})
		want := 200
		if origin != "https://folio.example" {
			want = 403
		}
		if w.Code != want {
			t.Fatalf("反向代理 Origin %s：期望 %d，实际 %d %s", origin, want, w.Code, w.Body.String())
		}
	}
}

func TestMCPPermissionToolRegistrationAndDirectCalls(t *testing.T) {
	e := newMCPTestEnv(t, "")
	all := []string{"listDirectory", "readContent", "getEntryRevision", "createFile", "createDirectory", "patchContent", "moveEntry", "trashEntry", "listTrash", "restoreEntry", "searchFiles", "updateContent", "downloadFile", "uploadFile"}
	for _, tc := range []struct {
		name    string
		perms   auth.TokenPermissions
		allowed []string
	}{
		{"只读正文", auth.TokenPermissions{Files: "read", Search: "none", Trash: "none"}, []string{"listDirectory", "readContent", "getEntryRevision", "downloadFile"}},
		{"只写正文", auth.TokenPermissions{Files: "write", Search: "none", Trash: "none"}, []string{"listDirectory", "readContent", "getEntryRevision", "createFile", "createDirectory", "patchContent", "moveEntry", "updateContent", "downloadFile", "uploadFile"}},
		{"仅搜索", auth.TokenPermissions{Files: "none", Search: "read", Trash: "none"}, []string{"searchFiles"}},
		{"只读回收站", auth.TokenPermissions{Files: "none", Search: "none", Trash: "read"}, []string{"listTrash"}},
		{"回收写但正文只读", auth.TokenPermissions{Files: "read", Search: "none", Trash: "write"}, []string{"listDirectory", "readContent", "getEntryRevision", "downloadFile", "listTrash"}},
		{"完整权限", auth.TokenPermissions{Files: "write", Search: "write", Trash: "write"}, all},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, secret := e.token(1, tc.perms)
			want := append([]string(nil), tc.allowed...)
			sort.Strings(want)
			if got := e.tools(secret); !reflect.DeepEqual(got, want) {
				t.Fatalf("工具权限过滤错误：实际 %v，期望 %v", got, want)
			}
			for _, name := range all {
				i := sort.SearchStrings(want, name)
				if i < len(want) && want[i] == name {
					continue
				}
				// 使用完整且有效的参数，不能把参数错误误判为权限隔离。
				args := map[string]any{"path": "denied.txt"}
				switch name {
				case "createFile":
					args["content"] = "denied"
				case "patchContent":
					args["diff"] = "@@ -1 +1 @@\n-a\n+b\n"
					args["expectedRevision"] = "sha256:" + strings.Repeat("0", 64)
				case "moveEntry":
					args = map[string]any{"from": "denied.txt", "to": "other.txt", "expectedRevision": "sha256:" + strings.Repeat("0", 64)}
				case "trashEntry":
					args["expectedRevision"] = "sha256:" + strings.Repeat("0", 64)
				case "restoreEntry":
					args = map[string]any{"id": "missing"}
				case "searchFiles":
					args = map[string]any{"query": "note"}
				case "listTrash":
					args = map[string]any{}
				}
				response, _ := e.tool(secret, name, args)
				if response.Error == nil || response.Error.Code != -32602 {
					t.Fatalf("未获准工具 %s 不应注册或可直调：%s %+v", name, response.Result, response.Error)
				}
			}
		})
	}
}

func TestMCPAccountIsolationRevocationAndDisabledUser(t *testing.T) {
	e := newMCPTestEnv(t, "")
	token, admin := e.token(1, auth.TokenPermissions{Files: "write", Search: "none", Trash: "none"})
	user, err := e.accounts.SaveUser(0, auth.UserInput{Username: "alice", Enabled: true, Quota: 1 << 20, Password: "mcp-alice-password-2026"})
	if err != nil {
		t.Fatal(err)
	}
	_, alice := e.token(user.ID, auth.TokenPermissions{Files: "write", Search: "none", Trash: "none"})
	for _, tc := range []struct{ secret, content string }{{admin, "admin"}, {alice, "alice"}} {
		e.success(tc.secret, "createFile", map[string]any{"path": "same.txt", "content": tc.content}, nil)
		w := e.request(tc.secret, "tools/call", map[string]any{"name": "readContent", "arguments": map[string]any{"path": "same.txt"}}, func(r *http.Request) {
			r.URL.RawQuery = "user_id=1"
			r.AddCookie(&http.Cookie{Name: cookieName, Value: e.cookie})
		})
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"content":"`+tc.content+`"`) {
			t.Fatalf("Cookie 或查询参数串号：%d %s", w.Code, w.Body.String())
		}
	}
	e.tools(admin)
	if err := e.accounts.DeleteAccessToken(1, token.ID); err != nil {
		t.Fatal(err)
	}
	if w := e.request(admin, "tools/list", map[string]any{}, nil); w.Code != 401 {
		t.Fatalf("撤销后仍可复用身份：%d %s", w.Code, w.Body.String())
	}
	e.tools(alice)
	if _, err := e.accounts.SaveUser(user.ID, auth.UserInput{Username: "alice", Enabled: false, Quota: 1 << 20}); err != nil {
		t.Fatal(err)
	}
	if w := e.request(alice, "tools/list", map[string]any{}, nil); w.Code != 401 {
		t.Fatalf("禁用账号后仍可复用身份：%d %s", w.Code, w.Body.String())
	}
}

func TestMCPContentPatchAndTrashLifecycle(t *testing.T) {
	e := newMCPTestEnv(t, "")
	_, secret := e.token(1, auth.TokenPermissions{Files: "write", Search: "read", Trash: "write"})
	args := func(path string) map[string]any { return map[string]any{"path": path} }
	e.success(secret, "createDirectory", args("notes"), nil)
	e.success(secret, "createFile", map[string]any{"path": "empty.txt", "content": ""}, nil)
	original := "\ufeffa\r\nb\nc\rtail"
	e.success(secret, "createFile", map[string]any{"path": "notes/note.txt", "content": original}, nil)
	var first storage.LineContent
	e.success(secret, "readContent", map[string]any{"path": "notes/note.txt", "lineCount": 1}, &first)
	if first.Content.Content != "\ufeffa\r\n" || first.Revision == "" || !first.IsPartial || !first.HasMore || first.NextLine != 2 || first.TotalLines != 4 || first.StartLine != 1 {
		t.Fatalf("首段内容或完整版本错误：%+v", first)
	}
	var second storage.LineContent
	e.success(secret, "readContent", map[string]any{"path": "notes/note.txt", "startLine": 2, "lineCount": 1000, "expectedRevision": first.Revision}, &second)
	if first.Content.Content+second.Content.Content != original || second.Revision != first.Revision || !second.IsPartial || second.HasMore {
		t.Fatalf("分段读取丢失正文或版本：%+v", second)
	}
	checkBytes := func(want string) {
		t.Helper()
		raw, err := os.ReadFile(filepath.Join(e.workspace, "1", "notes", "note.txt"))
		if err != nil || string(raw) != want {
			t.Fatalf("磁盘原文变化：%q，期望 %q，错误 %v", raw, want, err)
		}
	}
	e.failure(secret, "createFile", map[string]any{"path": "notes/note.txt", "content": "overwrite"}, "target_exists", false)
	diff := "@@ -2 +2 @@\n-b\n+B\n"
	patchArgs := map[string]any{"path": "notes/note.txt", "diff": diff, "expectedRevision": first.Revision, "dryRun": true}
	var preview storage.PatchResult
	e.success(secret, "patchContent", patchArgs, &preview)
	if !preview.DryRun || !preview.Changed || preview.Revision != first.Revision || preview.AddedLines != 1 || preview.DeletedLines != 1 {
		t.Fatalf("dryRun 返回异常：%+v", preview)
	}
	checkBytes(original)
	e.failure(secret, "patchContent", map[string]any{"path": "notes/note.txt", "diff": diff}, "precondition_required", true)
	e.failure(secret, "patchContent", map[string]any{"path": "notes/note.txt", "diff": diff, "expectedRevision": ""}, "precondition_required", false)
	e.failure(secret, "patchContent", map[string]any{"path": "notes/note.txt", "diff": "@@ -2 +2 @@\n-wrong\n+B\n", "expectedRevision": first.Revision}, "patch_mismatch", false)
	checkBytes(original)
	patchArgs["dryRun"] = false
	var patched storage.PatchResult
	e.success(secret, "patchContent", patchArgs, &patched)
	if patched.Revision == first.Revision || patched.Revision == "" || patched.DryRun {
		t.Fatalf("补丁未产生新版本：%+v", patched)
	}
	want := "\ufeffa\r\nB\nc\rtail"
	checkBytes(want)
	e.failure(secret, "patchContent", patchArgs, "revision_conflict", false)
	e.failure(secret, "readContent", map[string]any{"path": "notes/note.txt", "startLine": 2, "expectedRevision": first.Revision}, "revision_conflict", false)
	checkBytes(want)
	var revision struct {
		Revision string `json:"revision"`
	}
	e.success(secret, "getEntryRevision", args("notes/note.txt"), &revision)
	if revision.Revision != patched.Revision {
		t.Fatal("getEntryRevision 与正文版本不一致")
	}
	e.success(secret, "listDirectory", map[string]any{}, nil)
	e.success(secret, "listDirectory", map[string]any{"path": "notes", "offset": 0, "limit": 1000}, nil)
	e.success(secret, "searchFiles", map[string]any{"query": "note", "mode": "names"}, nil)
	e.failure(secret, "moveEntry", map[string]any{"from": "notes/note.txt", "to": "notes/moved.txt", "expectedRevision": first.Revision}, "revision_conflict", false)
	e.success(secret, "moveEntry", map[string]any{"from": "notes/note.txt", "to": "notes/moved.txt", "expectedRevision": patched.Revision}, nil)
	e.failure(secret, "readContent", args("notes/note.txt"), "not_found", false)
	e.success(secret, "getEntryRevision", args("notes/moved.txt"), &revision)
	var record struct {
		ID string `json:"id"`
	}
	e.success(secret, "trashEntry", map[string]any{"path": "notes/moved.txt", "expectedRevision": revision.Revision}, &record)
	if record.ID == "" {
		t.Fatal("回收结果缺少恢复 ID")
	}
	e.failure(secret, "readContent", args("notes/moved.txt"), "not_found", false)
	var trash struct {
		Entries []struct {
			ID string `json:"id"`
		} `json:"entries"`
		Total int `json:"total"`
	}
	e.success(secret, "listTrash", map[string]any{"offset": 0, "limit": 1000}, &trash)
	if trash.Total != 1 || len(trash.Entries) != 1 || trash.Entries[0].ID != record.ID {
		t.Fatalf("回收列表未包含记录：%+v", trash)
	}
	e.success(secret, "restoreEntry", map[string]any{"id": record.ID}, nil)
	var restored storage.LineContent
	e.success(secret, "readContent", args("notes/moved.txt"), &restored)
	raw, err := os.ReadFile(filepath.Join(e.workspace, "1", "notes", "moved.txt"))
	if err != nil || string(raw) != want || restored.Content.Content != want || restored.IsPartial {
		t.Fatalf("恢复未保持完整原文：%q %+v %v", raw, restored, err)
	}
}

func TestMCPBOMFirstLineDiagnosticsAndMoveRevision(t *testing.T) {
	e := newMCPTestEnv(t, "")
	_, secret := e.token(1, auth.TokenPermissions{Files: "write", Search: "none", Trash: "none"})
	original := "\ufeff第一行\r\nsecond\nthird\r"
	e.success(secret, "createFile", map[string]any{"path": "bom.txt", "content": original}, nil)
	var first storage.LineContent
	e.success(secret, "readContent", map[string]any{"path": "bom.txt", "lineCount": 1}, &first)
	diff := "@@ -1 +1 @@\n-" + strings.TrimSuffix(first.Content.Content, "\r\n") + "\n+\ufeff替换后\n"
	args := map[string]any{"path": "bom.txt", "expectedRevision": first.Revision, "diff": diff, "dryRun": true}
	var result storage.PatchResult
	e.success(secret, "patchContent", args, &result)
	if result.Revision != first.Revision {
		t.Fatal("BOM预检消耗了版本")
	}
	raw, err := os.ReadFile(filepath.Join(e.workspace, "1", "bom.txt"))
	if err != nil || string(raw) != original {
		t.Fatalf("BOM预检改写正文：%q %v", raw, err)
	}
	args["dryRun"] = false
	e.success(secret, "patchContent", args, &result)
	want := "\ufeff替换后\r\nsecond\nthird\r"
	raw, err = os.ReadFile(filepath.Join(e.workspace, "1", "bom.txt"))
	if err != nil || string(raw) != want {
		t.Fatalf("首行读取构造的补丁丢失原始字节：%q %v", raw, err)
	}
	response, failure := e.tool(secret, "patchContent", map[string]any{"path": "bom.txt", "expectedRevision": result.Revision, "diff": "@@ -1,2 +1,2 @@\n \ufeff替换后\n-wrong\n+SECOND\n"})
	var problem struct {
		Error struct {
			Code    string
			Details map[string]any
		}
	}
	if err := json.Unmarshal(failure.StructuredContent, &problem); err != nil {
		t.Fatal(err)
	}
	if response.Error != nil || !failure.IsError || problem.Error.Code != "patch_mismatch" || problem.Error.Details["hunkIndex"] != float64(0) || problem.Error.Details["line"] != float64(2) || problem.Error.Details["reason"] != "deleted_content_mismatch" || len(problem.Error.Details) != 3 {
		t.Fatalf("补丁未给出有界定位：%s", failure.StructuredContent)
	}
	var moved struct{ From, To, Revision string }
	e.success(secret, "moveEntry", map[string]any{"from": "bom.txt", "to": "moved.txt", "expectedRevision": result.Revision}, &moved)
	if moved.From != "bom.txt" || moved.To != "moved.txt" || moved.Revision != result.Revision {
		t.Fatalf("移动结果版本错误：%+v", moved)
	}
	var tail storage.LineContent
	e.success(secret, "readContent", map[string]any{"path": "moved.txt", "startLine": 2, "expectedRevision": moved.Revision}, &tail)
	if tail.HasMore || !tail.IsPartial || tail.Content.Content != "second\nthird\r" {
		t.Fatalf("尾段含义或版本错误：%+v", tail)
	}
	_, failure = e.tool(secret, "createFile", map[string]any{"path": "missing/parent/file.txt", "content": "must not save"})
	if err := json.Unmarshal(failure.StructuredContent, &problem); err != nil {
		t.Fatal(err)
	}
	if !failure.IsError || problem.Error.Code != "not_found" || problem.Error.Details["reason"] != "parent_not_found" || problem.Error.Details["path"] != "missing/parent" {
		t.Fatalf("父目录错误不明确：%s", failure.StructuredContent)
	}
	if _, err := os.Stat(filepath.Join(e.workspace, "1", "missing")); !os.IsNotExist(err) {
		t.Fatalf("失败时创建了父目录：%v", err)
	}
}

func TestMCPPathBoundaryAndArgumentValidation(t *testing.T) {
	e := newMCPTestEnv(t, "")
	_, secret := e.token(1, auth.TokenPermissions{Files: "write", Search: "read", Trash: "write"})
	e.success(secret, "createFile", map[string]any{"path": "empty.txt", "content": ""}, nil)
	for _, name := range []string{"readContent", "getEntryRevision", "createDirectory"} {
		e.failure(secret, name, map[string]any{"path": "../outside.txt"}, "path_invalid", false)
	}
	e.failure(secret, "createFile", map[string]any{"path": "../outside.txt", "content": "escaped"}, "path_invalid", false)
	for _, tc := range []struct {
		name string
		args map[string]any
		code string
	}{
		{"createFile", map[string]any{"path": "missing.txt"}, "invalid_request"},
		{"createFile", map[string]any{"path": "null.txt", "content": nil}, "invalid_request"},
		{"readContent", map[string]any{}, "path_missing"},
		{"readContent", map[string]any{"path": "empty.txt", "lineCount": 1001}, "invalid_line_range"},
		{"readContent", map[string]any{"path": "empty.txt", "lineCount": 0}, "invalid_line_range"},
		{"readContent", map[string]any{"path": "empty.txt", "startLine": 0}, "invalid_line_range"},
		{"listDirectory", map[string]any{"limit": 1001}, "invalid_request"},
		{"listDirectory", map[string]any{"limit": 0}, "invalid_request"},
		{"searchFiles", map[string]any{"query": "x", "limit": 201}, "invalid_request"},
		{"searchFiles", map[string]any{"query": "x", "limit": 0}, "invalid_request"},
	} {
		e.failure(secret, tc.name, tc.args, tc.code, true)
	}
	for _, path := range []string{"outside.txt", "1/missing.txt", "1/null.txt"} {
		if _, err := os.Stat(filepath.Join(e.workspace, path)); !os.IsNotExist(err) {
			t.Fatalf("失败调用产生了文件 %s：%v", path, err)
		}
	}
}

func TestMCPRejectsBatchAndBoundsHTTPBody(t *testing.T) {
	e := newMCPTestEnv(t, "")
	_, secret := e.token(1, auth.TokenPermissions{Files: "write", Search: "none", Trash: "none"})
	batch := ` [{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"createFile","arguments":{"path":"batch.txt","content":"must not save"}}}]`
	for _, version := range []string{"", "2025-03-26", "2025-06-18", "2026-07-28"} {
		w := e.request(secret, "tools/list", map[string]any{}, func(r *http.Request) {
			r.Body = io.NopCloser(strings.NewReader(batch))
			r.ContentLength = int64(len(batch))
			r.Header.Del("MCP-Protocol-Version")
			if version != "" {
				r.Header.Set("MCP-Protocol-Version", version)
			}
		})
		if w.Code != 400 {
			t.Fatalf("协议 %q 批量调用未拒绝：%d %s", version, w.Code, w.Body.String())
		}
	}
	if _, err := os.Stat(filepath.Join(e.workspace, "1", "batch.txt")); !os.IsNotExist(err) {
		t.Fatalf("拒绝的批量请求仍执行了工具：%v", err)
	}
	large := strings.Repeat("x", mcpReadByteLimit+1) + "\nsmall\n"
	e.success(secret, "createFile", map[string]any{"path": "large.txt", "content": large}, nil)
	e.failure(secret, "readContent", map[string]any{"path": "large.txt", "lineCount": 1}, "too_large", false)
	var selected storage.LineContent
	e.success(secret, "readContent", map[string]any{"path": "large.txt", "startLine": 2, "lineCount": 1}, &selected)
	if selected.Content.Content != "small\n" || !selected.IsPartial {
		t.Fatalf("有界读取被静默截断或误报全文：%+v", selected)
	}
	for _, body := range []string{
		strings.Repeat(" ", mcpRequestByteLimit+1),
		`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"padding":"` + strings.Repeat("x", mcpRequestByteLimit) + `"}}`,
	} {
		w := e.request(secret, "tools/list", map[string]any{}, func(r *http.Request) {
			r.Body = io.NopCloser(strings.NewReader(body))
			r.ContentLength = -1
		})
		if w.Code != 413 {
			t.Fatalf("无Content-Length的超限请求未拒绝：%d %s", w.Code, w.Body.String())
		}
		var problem struct {
			Error struct {
				Code    string
				Details map[string]any
			}
		}
		if err := json.Unmarshal(w.Body.Bytes(), &problem); err != nil || problem.Error.Code != "too_large" || problem.Error.Details == nil {
			t.Fatalf("传输超限未返回结构化错误：%s %v", w.Body.String(), err)
		}
	}
}

type mcpTestBearerTransport struct {
	secret string
	base   http.RoundTripper
}

func (b mcpTestBearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.secret)
	return b.base.RoundTrip(r)
}

func TestMCPOfficialClientHTTPRoundTrip(t *testing.T) {
	e := newMCPTestEnv(t, "")
	token, secret := e.token(1, auth.TokenPermissions{Files: "write", Search: "none", Trash: "none"})
	server := httptest.NewServer(e.handler)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client := mcp.NewClient(&mcp.Implementation{Name: "folio-official-client-test", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: server.URL + "/mcp", HTTPClient: &http.Client{Transport: mcpTestBearerTransport{secret: secret, base: server.Client().Transport}}, DisableStandaloneSSE: true, MaxRetries: -1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if version := session.InitializeResult().ProtocolVersion; version != "2026-07-28" {
		t.Fatalf("官方客户端未使用当前协议：%s", version)
	}
	tools, err := session.ListTools(ctx, &mcp.ListToolsParams{})
	if err != nil || len(tools.Tools) != 10 {
		t.Fatalf("官方客户端列工具失败：%+v %v", tools, err)
	}
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "createFile", Arguments: map[string]any{"path": "official.txt", "content": "HTTP MCP"}})
	if err != nil || result.IsError || result.StructuredContent == nil {
		t.Fatalf("官方客户端调用失败：%+v %v", result, err)
	}
	result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: "readContent", Arguments: map[string]any{"path": "official.txt"}})
	if err != nil || result.IsError {
		t.Fatalf("官方客户端读取失败：%+v %v", result, err)
	}
	encoded, err := json.Marshal(result.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	var read struct{ Revision string }
	if err := json.Unmarshal(encoded, &read); err != nil {
		t.Fatal(err)
	}
	result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: "updateContent", Arguments: map[string]any{"path": "official.txt", "content": "updated HTTP MCP", "expectedRevision": read.Revision}})
	if err != nil || result.IsError {
		t.Fatalf("官方客户端整篇替换失败：%+v %v", result, err)
	}
	result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: "uploadFile", Arguments: map[string]any{"path": "official.bin", "contentBase64": "AP8BAg=="}})
	if err != nil || result.IsError {
		t.Fatalf("官方客户端上传失败：%+v %v", result, err)
	}
	result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: "downloadFile", Arguments: map[string]any{"path": "official.bin"}})
	if err != nil || result.IsError || len(result.Content) != 2 {
		t.Fatalf("官方客户端原生附件失败：%+v %v", result, err)
	}
	resource, ok := result.Content[1].(*mcp.EmbeddedResource)
	if !ok || resource.Resource == nil || !bytes.Equal(resource.Resource.Blob, []byte{0, 255, 1, 2}) {
		t.Fatalf("官方客户端附件字节不一致：%+v", result)
	}
	if err := e.accounts.DeleteAccessToken(1, token.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := session.ListTools(ctx, &mcp.ListToolsParams{}); err == nil {
		t.Fatal("真实 HTTP 客户端在撤销令牌后仍可复用会话身份")
	}
}
