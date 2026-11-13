package httpapi

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"folio/internal/auth"
	"folio/internal/storage"
)

type mcpDownloadEnv struct {
	service     *mcpDownloads
	auth        *auth.Service
	store       *storage.Store
	user        auth.User
	token       auth.AccessToken
	secret      string
	dir         string
	workspaceID string
}

func newMCPDownloadEnv(t *testing.T) *mcpDownloadEnv {
	t.Helper()
	base := t.TempDir()
	data, dir := filepath.Join(base, "data"), filepath.Join(base, "workspace")
	for _, p := range []string{data, dir} {
		if err := os.Mkdir(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	a, err := auth.Open(data, "download-admin-password-2026")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	u, err := a.SaveUser(0, auth.UserInput{Username: "download", Password: "download-user-password-2026", Quota: auth.DefaultQuota, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	e := &mcpDownloadEnv{auth: a, store: store, user: u, dir: dir, workspaceID: "workspace-download"}
	e.token, e.secret, err = a.CreateAccessToken(u.ID, e.workspaceID, "下载", 0, auth.TokenPermissions{Files: "read", Search: "none", Trash: "none"})
	if err != nil {
		t.Fatal(err)
	}
	e.service = newMCPDownloads(a, func(ownerID int64) (*storage.Store, string, error) {
		if ownerID != u.ID {
			return nil, "", fmt.Errorf("错误账号")
		}
		return store, e.workspaceID, nil
	})
	if err := os.WriteFile(filepath.Join(dir, "raw.bin"), []byte{0, 1, 2, 255, '\r', '\n'}, 0600); err != nil {
		t.Fatal(err)
	}
	return e
}

func (e *mcpDownloadEnv) issue(t *testing.T) (string, map[string]any) {
	t.Helper()
	result, err := e.service.issue("https://files.example:8443", e.user.ID, &e.token, "raw.bin")
	if err != nil {
		t.Fatal(err)
	}
	url := result["url"].(string)
	if !strings.HasPrefix(url, "https://files.example:8443/api/v1/public/mcp-download/") || strings.Contains(url, e.secret) {
		t.Fatal("URL来源或凭据错误")
	}
	ticket := url[strings.LastIndex(url, "/")+1:]
	if nonce, err := base64.RawURLEncoding.DecodeString(ticket); err != nil || len(nonce) != 32 {
		t.Fatal("票据随机数不足256bit")
	}
	return ticket, result
}

func (e *mcpDownloadEnv) get(ticket, method, rangeHeader string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://untrusted.example/download", nil)
	r.SetPathValue("ticket", ticket)
	r.Header.Set("X-Forwarded-Host", "evil.example")
	if rangeHeader != "" {
		r.Header.Set("Range", rangeHeader)
	}
	w := httptest.NewRecorder()
	e.service.ServeHTTP(w, r)
	return w
}

func downloadErrorCode(t *testing.T, w *httptest.ResponseRecorder, secrets ...string) string {
	t.Helper()
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body.Error.Code == "" {
		t.Fatalf("缺少JSON错误: %d %q", w.Code, w.Body.String())
	}
	for _, secret := range secrets {
		if secret != "" && strings.Contains(w.Body.String(), secret) {
			t.Fatal("错误泄露秘密或正文")
		}
	}
	return body.Error.Code
}

func TestMCPDownloadBytesAndSingleConsumption(t *testing.T) {
	e := newMCPDownloadEnv(t)
	ticket, result := e.issue(t)
	w := e.get(ticket, http.MethodGet, "")
	data := []byte{0, 1, 2, 255, '\r', '\n'}
	hash := sha256.Sum256(data)
	if w.Code != 200 || w.Body.String() != string(data) || result["revision"] != "sha256:"+hex.EncodeToString(hash[:]) || result["size"] != int64(len(data)) {
		t.Fatalf("原始字节或版本错误: %d %v", w.Code, result)
	}
	for key, want := range map[string]string{"Content-Type": "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "sandbox; default-src 'none'"} {
		if w.Header().Get(key) != want {
			t.Fatalf("%s=%q", key, w.Header().Get(key))
		}
	}
	if !strings.HasPrefix(w.Header().Get("Content-Disposition"), "attachment;") {
		t.Fatal("未隔离下载")
	}
	w = e.get(ticket, http.MethodGet, "")
	if w.Code != 404 || downloadErrorCode(t, w, e.secret, ticket) != "not_found" {
		t.Fatal("票据重复使用")
	}
	ticket, _ = e.issue(t)
	var wg sync.WaitGroup
	results := make(chan int, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); results <- e.get(ticket, http.MethodGet, "").Code }()
	}
	wg.Wait()
	close(results)
	success := 0
	for status := range results {
		if status == 200 {
			success++
		} else if status != 404 {
			t.Fatalf("并发状态: %d", status)
		}
	}
	if success != 1 {
		t.Fatalf("原子消费成功次数: %d", success)
	}
}

func TestMCPDownloadRejectWithoutConsumption(t *testing.T) {
	e := newMCPDownloadEnv(t)
	for _, tc := range []struct {
		method, header string
		status         int
	}{{"HEAD", "", 405}, {"POST", "", 405}, {"GET", "bytes=0-1", 400}} {
		ticket, _ := e.issue(t)
		w := e.get(ticket, tc.method, tc.header)
		if w.Code != tc.status || downloadErrorCode(t, w, e.secret, ticket) != "invalid_request" {
			t.Fatal("未明确拒绝不支持的请求")
		}
		if w = e.get(ticket, "GET", ""); w.Code != 200 {
			t.Fatal("HEAD/Range消费了票据", w.Code)
		}
	}
}

func TestMCPDownloadConditionalRequestStillReturnsBytes(t *testing.T) {
	e := newMCPDownloadEnv(t)
	ticket, _ := e.issue(t)
	r := httptest.NewRequest(http.MethodGet, "http://untrusted.example/download", nil)
	r.SetPathValue("ticket", ticket)
	r.Header.Set("If-None-Match", "*")
	r.Header.Set("If-Modified-Since", time.Now().Add(time.Hour).UTC().Format(http.TimeFormat))
	w := httptest.NewRecorder()
	e.service.ServeHTTP(w, r)
	if w.Code != 200 || w.Body.Len() != 6 {
		t.Fatal("条件缓存吞掉单次下载", w.Code)
	}
	if e.get(ticket, "GET", "").Code != 404 {
		t.Fatal("条件GET未消费票据")
	}
}

func TestMCPDownloadIssueChecksCurrentPrincipal(t *testing.T) {
	e := newMCPDownloadEnv(t)
	for _, access := range []*auth.AccessToken{nil, {ID: e.token.ID, WorkspaceID: "wrong"}, {ID: -1, WorkspaceID: e.workspaceID}} {
		if _, err := e.service.issue("https://files.example", e.user.ID, access, "raw.bin"); err == nil {
			t.Fatal("未验证签发令牌")
		}
	}
	if _, err := e.service.issue("https://files.example", e.user.ID+1, &e.token, "raw.bin"); err == nil {
		t.Fatal("可跨账号签发")
	}
	write, _, err := e.auth.CreateAccessToken(e.user.ID, e.workspaceID, "写入", 0, auth.TokenPermissions{Files: "write", Search: "none", Trash: "none"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.service.issue("https://files.example", e.user.ID, &write, "raw.bin"); err != nil {
		t.Fatal("write权限不能读取", err)
	}
	if err := e.auth.DeleteAccessToken(e.user.ID, e.token.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.service.issue("https://files.example", e.user.ID, &e.token, "raw.bin"); err == nil {
		t.Fatal("旧principal可在撤销后签发")
	}
}

func TestMCPDownloadRevalidation(t *testing.T) {
	for _, state := range []string{"expire", "revoke", "disable", "workspace", "file", "size", "unsafe", "owner", "token_workspace", "permissions"} {
		t.Run(state, func(t *testing.T) {
			e := newMCPDownloadEnv(t)
			ticket, _ := e.issue(t)
			switch state {
			case "expire":
				e.service.now = func() time.Time { return time.Now().Add(61 * time.Second) }
			case "revoke":
				if err := e.auth.DeleteAccessToken(e.user.ID, e.token.ID); err != nil {
					t.Fatal(err)
				}
			case "disable":
				if _, err := e.auth.SaveUser(e.user.ID, auth.UserInput{Username: e.user.Username, Quota: e.user.Quota, Enabled: false}); err != nil {
					t.Fatal(err)
				}
			case "workspace":
				e.workspaceID = "another-workspace"
			case "file":
				if err := os.WriteFile(filepath.Join(e.dir, "raw.bin"), []byte("changed secret body"), 0600); err != nil {
					t.Fatal(err)
				}
			case "size":
				limits := e.store.Limits()
				limits.Text, limits.Image, limits.PDF, limits.Attachment = 4, 4, 4, 4
				if err := e.store.SetLimits(limits); err != nil {
					t.Fatal(err)
				}
			case "unsafe":
				if err := os.Rename(filepath.Join(e.dir, "raw.bin"), filepath.Join(e.dir, "original.bin")); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("original.bin", filepath.Join(e.dir, "raw.bin")); err != nil {
					t.Fatal(err)
				}
			default:
				e.service.mu.Lock()
				key := sha256.Sum256([]byte(ticket))
				value := e.service.tickets[key]
				if state == "owner" {
					value.ownerID++
				} else if state == "token_workspace" {
					value.workspaceID = "another-workspace"
				} else {
					tok, _, err := e.auth.CreateAccessToken(e.user.ID, e.workspaceID, "搜索", 0, auth.TokenPermissions{Files: "none", Search: "read", Trash: "none"})
					if err != nil {
						t.Fatal(err)
					}
					value.accessTokenID = tok.ID
				}
				e.service.tickets[key] = value
				e.service.mu.Unlock()
			}
			w := e.get(ticket, "GET", "")
			code := downloadErrorCode(t, w, e.secret, ticket, "changed secret body")
			want := "forbidden"
			if state == "expire" {
				want = "not_found"
			}
			if state == "revoke" || state == "disable" {
				want = "unauthenticated"
			}
			if state == "file" {
				want = "revision_conflict"
			}
			if state == "size" {
				want = "too_large"
			}
			if state == "unsafe" {
				want = "path_invalid"
			}
			if code != want {
				t.Fatalf("%s: %d %s", state, w.Code, code)
			}
			if e.get(ticket, "GET", "").Code != 404 {
				t.Fatal("失败后票据可重用")
			}
		})
	}
}

func TestMCPDownloadOriginAndUnsafePaths(t *testing.T) {
	e := newMCPDownloadEnv(t)
	for _, origin := range []string{"", "//files.example", "ftp://files.example", "https://user:password@files.example", "https://files.example/", "https://files.example/path", "https://files.example?x=1", "https://files.example?", "https://files.example#fragment", "https://files.example#", "https://", "https://files.example:abc", "https://files.example:99999", "https://files.example:", "https://files.example\\evil"} {
		if _, err := e.service.issue(origin, e.user.ID, &e.token, "raw.bin"); err == nil {
			t.Fatalf("接受非法Origin: %q", origin)
		}
	}
	for _, origin := range []string{"http://localhost:9099", "https://files.example", "http://[::1]:9099"} {
		if _, err := e.service.issue(origin, e.user.ID, &e.token, "raw.bin"); err != nil {
			t.Fatal(origin, err)
		}
	}
	if err := os.Symlink(filepath.Join(e.dir, "raw.bin"), filepath.Join(e.dir, "link.bin")); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(e.dir, "raw.bin"), filepath.Join(e.dir, "hard.bin")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(e.dir, "directory"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"", "../outside", "/etc/passwd", "a/../../raw.bin", "link.bin", "hard.bin", "directory"} {
		if _, err := e.service.issue("https://files.example", e.user.ID, &e.token, name); err == nil {
			t.Fatalf("不安全路径通过: %q", name)
		}
	}
}

func TestMCPDownloadBoundedCacheAndRead(t *testing.T) {
	e := newMCPDownloadEnv(t)
	clock := time.Now()
	e.service.now = func() time.Time { return clock }
	var first string
	for i := 0; i < 128; i++ {
		ticket, _ := e.issue(t)
		if i == 0 {
			first = ticket
		}
	}
	if _, err := e.service.issue("https://files.example", e.user.ID, &e.token, "raw.bin"); err == nil {
		t.Fatal("缓存未限制")
	}
	if len(e.service.tickets) != 128 {
		t.Fatal("缓存超过上限")
	}
	for key, value := range e.service.tickets {
		if fmt.Sprint(key) == first || strings.Contains(fmt.Sprint(value), e.secret) {
			t.Fatal("缓存含凭据")
		}
	}
	clock = clock.Add(60 * time.Second)
	e.issue(t)
	if len(e.service.tickets) != 1 || e.get(first, "GET", "").Code != 404 {
		t.Fatal("过期票据未有界清理")
	}
	if err := os.WriteFile(filepath.Join(e.dir, "large.bin"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(filepath.Join(e.dir, "large.bin"), mcpDownloadLimit+1); err != nil {
		t.Fatal(err)
	}
	if _, err := e.service.issue("https://files.example", e.user.ID, &e.token, "large.bin"); err == nil {
		t.Fatal("超过100MiB仍可签发")
	}
	limits := e.store.Limits()
	limits.Text = 4
	limits.Image = 4
	limits.PDF = 4
	limits.Attachment = 4
	if err := e.store.SetLimits(limits); err != nil {
		t.Fatal(err)
	}
	if _, err := e.service.issue("https://files.example", e.user.ID, &e.token, "raw.bin"); err == nil {
		t.Fatal("未应用工作区附件上限")
	}
	if file, _, _, err := openMCPDownload(e.store, "raw.bin", 3); err == nil || file != nil {
		t.Fatal("helper未关闭超限描述符")
	}
}
