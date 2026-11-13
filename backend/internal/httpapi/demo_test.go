package httpapi

import (
	"bytes"
	"encoding/json"
	"folio/internal/auth"
	"folio/internal/config"
	"folio/internal/storage"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
)

const demoTestAdminPassword = "admin-demo-test-password"
const demoTestWelcome = "欢迎体验 Folio.md"

type demoTestApp struct {
	t        *testing.T
	cfg      config.Config
	accounts *auth.Service
	handler  *Accounts
}

type demoTestSession struct {
	cookie *http.Cookie
	ID     int64  `json:"id"`
	Admin  bool   `json:"admin"`
	CSRF   string `json:"csrfToken"`
}

func newDemoTestApp(t *testing.T, enabled bool) *demoTestApp {
	t.Helper()
	base := t.TempDir()
	a := &demoTestApp{t: t, cfg: config.Config{Workspace: filepath.Join(base, "workspace"), AppData: filepath.Join(base, "data"), DemoMode: enabled, Limits: storage.DefaultLimits, IndexLimit: 1 << 20}}
	for _, dir := range []string{a.cfg.Workspace, a.cfg.AppData} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(a.close)
	a.openAuth()
	return a
}

func (a *demoTestApp) openAuth() {
	a.t.Helper()
	var err error
	a.accounts, err = auth.Open(a.cfg.AppData, demoTestAdminPassword)
	if err != nil {
		a.t.Fatal(err)
	}
}

func (a *demoTestApp) start() error {
	var err error
	a.handler, err = NewAccounts(fstest.MapFS{"index.html": {Data: []byte("Folio")}}, a.cfg, a.accounts)
	return err
}

func (a *demoTestApp) mustStart() {
	a.t.Helper()
	if err := a.start(); err != nil {
		a.t.Fatal(err)
	}
}

func (a *demoTestApp) close() {
	if a.handler != nil {
		if err := a.handler.Close(); err != nil {
			a.t.Error(err)
		}
		a.handler = nil
	}
	if a.accounts != nil {
		if err := a.accounts.Close(); err != nil {
			a.t.Error(err)
		}
		a.accounts = nil
	}
}

func (a *demoTestApp) restart(enabled bool) {
	a.t.Helper()
	a.close()
	a.cfg.DemoMode = enabled
	a.openAuth()
	a.mustStart()
}

func (a *demoTestApp) call(s demoTestSession, method, path string, body any) *httptest.ResponseRecorder {
	a.t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		a.t.Fatal(err)
	}
	r := httptest.NewRequest(method, "/api/v1"+path, bytes.NewReader(encoded))
	r.Header.Set("Content-Type", "application/json")
	if s.cookie != nil {
		r.AddCookie(s.cookie)
		r.Header.Set("X-CSRF-Token", s.CSRF)
	}
	w := httptest.NewRecorder()
	a.handler.ServeHTTP(w, r)
	return w
}

func demoTestStatus(t *testing.T, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("状态应为 %d，实际 %d：%s", status, w.Code, w.Body.String())
	}
	if code != "" {
		var result struct{ Error struct{ Code string } }
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || result.Error.Code != code {
			t.Fatalf("错误代码应为 %s：%s（%v）", code, w.Body.String(), err)
		}
	}
}

func (a *demoTestApp) login(name, password string) demoTestSession {
	a.t.Helper()
	w := a.call(demoTestSession{}, "POST", "/auth/login", map[string]string{"username": name, "password": password})
	demoTestStatus(a.t, w, 200, "")
	var s demoTestSession
	if err := json.Unmarshal(w.Body.Bytes(), &s); err != nil {
		a.t.Fatal(err)
	}
	for _, cookie := range w.Result().Cookies() {
		if cookie.Name == cookieName {
			s.cookie = cookie
		}
	}
	if s.cookie == nil || s.CSRF == "" || s.ID == 0 {
		a.t.Fatalf("登录未返回完整身份和 Cookie：%s", w.Body.String())
	}
	return s
}

func (a *demoTestApp) demoUser() auth.User {
	a.t.Helper()
	users, total, err := a.accounts.Users("folio", 0, 20)
	if err != nil || total != 1 || len(users) != 1 || users[0].Username != "folio" {
		a.t.Fatalf("演示账号查询失败：%+v total=%d err=%v", users, total, err)
	}
	return users[0]
}

func (a *demoTestApp) welcomePath(id int64) string {
	return filepath.Join(a.cfg.Workspace, strconv.FormatInt(id, 10), demoTestWelcome)
}

func TestDemoModeOffAndRealAccountCollision(t *testing.T) {
	a := newDemoTestApp(t, false)
	a.mustStart()
	if users, total, err := a.accounts.Users("folio", 0, 20); err != nil || total != 0 || len(users) != 0 {
		t.Fatalf("关闭模式不应创建演示账号：%+v %d %v", users, total, err)
	}
	u, err := a.accounts.SaveUser(0, auth.UserInput{Username: "folio", Enabled: true, Quota: 1234, Password: "real-folio-password"})
	if err != nil {
		t.Fatal(err)
	}
	a.restart(false)
	if s := a.login("folio", "real-folio-password"); s.ID != u.ID {
		t.Fatal("关闭模式改变了真实同名账号")
	}
	a.close()
	a.cfg.DemoMode = true
	a.openAuth()
	if err := a.start(); err == nil {
		t.Fatal("演示模式接管了真实同名账号")
	}
	if _, p, err := a.accounts.Login("folio", "real-folio-password", "", "collision"); err != nil || p.ID != u.ID {
		t.Fatalf("冲突启动破坏了真实账号凭据：%v", err)
	}
	if got, err := a.accounts.User(u.ID); err != nil || !got.Enabled || got.Quota != 1234 {
		t.Fatalf("冲突启动修改了真实账号：%+v %v", got, err)
	}
}

func TestDemoInitializationAndAccountRestrictions(t *testing.T) {
	a := newDemoTestApp(t, true)
	a.mustStart()
	u := a.demoUser()
	if u.ID <= 1 || u.Admin || !u.Enabled || u.Quota != 100<<20 {
		t.Fatalf("演示账号身份或配额错误：%+v", u)
	}
	s := a.login("folio", "folio")
	if s.Admin || s.ID != u.ID {
		t.Fatal("演示登录获得了管理员身份")
	}
	w := a.call(s, "GET", "/auth/me", nil)
	demoTestStatus(t, w, 200, "")
	var me demoTestSession
	if err := json.Unmarshal(w.Body.Bytes(), &me); err != nil || me.Admin || me.ID != u.ID {
		t.Fatalf("当前身份错误：%s %v", w.Body.String(), err)
	}
	body, err := os.ReadFile(a.welcomePath(u.ID))
	if err != nil {
		t.Fatal(err)
	}
	for _, feature := range []string{"# ", "Markdown", "- [ ]", "```", "搜索", "分享", "MCP"} {
		if !bytes.Contains(body, []byte(feature)) {
			t.Errorf("介绍未包含标准 Markdown 或功能 %q", feature)
		}
	}
	demoTestStatus(t, a.call(s, "POST", "/auth/password", map[string]string{"oldPassword": "folio", "newPassword": "changed-password"}), 403, "demo_restricted")
	a.login("folio", "folio")
	for _, path := range []string{"/admin/users", "/admin/settings", "/admin/status"} {
		demoTestStatus(t, a.call(s, "GET", path, nil), 403, "")
	}
	admin := a.login("admin", demoTestAdminPassword)
	if !admin.Admin || admin.ID != 1 {
		t.Fatal("演示模式替换了正常管理员")
	}
	id := strconv.FormatInt(u.ID, 10)
	demoTestStatus(t, a.call(admin, "PATCH", "/admin/users/"+id, auth.UserInput{Username: "renamed", Enabled: true, Quota: 1}), 403, "demo_restricted")
	demoTestStatus(t, a.call(admin, "POST", "/admin/users/"+id+"/password", map[string]string{"password": "changed-password"}), 403, "demo_restricted")
	demoTestStatus(t, a.call(admin, "POST", "/admin/users", auth.UserInput{Username: "ordinary", Enabled: true, Quota: 1024, Password: "folio"}), 400, "")
	demoTestStatus(t, a.call(admin, "POST", "/auth/password", map[string]string{"oldPassword": demoTestAdminPassword, "newPassword": "folio"}), 400, "")
	a.login("admin", demoTestAdminPassword)
	a.login("folio", "folio")
}

func TestDemoSeedPreservesEditsAndDeletionAcrossRestarts(t *testing.T) {
	a := newDemoTestApp(t, true)
	a.mustStart()
	id := a.demoUser().ID
	path := a.welcomePath(id)
	original := []byte("\xef\xbb\xbf# 用户修改\r\n\r\n末尾空格  \r\n")
	if err := os.WriteFile(path, original, 0600); err != nil {
		t.Fatal(err)
	}
	a.restart(true)
	if got, err := os.ReadFile(path); err != nil || !bytes.Equal(got, original) {
		t.Fatalf("重启改写原文字节：%q %v", got, err)
	}
	if a.demoUser().ID != id {
		t.Fatal("重启创建了另一演示账号")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	a.restart(true)
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("重启复活了已删除介绍：%v", err)
	}
}

func TestDemoSeedPreservesExistingWelcome(t *testing.T) {
	a := newDemoTestApp(t, true)
	// 先由认证层分配实际 ID，不依赖演示账号必定是第二个账号。
	u, seeded, err := a.accounts.ConfigureDemo(true)
	if err != nil || seeded {
		t.Fatalf("预分配演示账号失败：%v seeded=%v", err, seeded)
	}
	if err := os.Mkdir(filepath.Dir(a.welcomePath(u.ID)), 0700); err != nil {
		t.Fatal(err)
	}
	original := []byte("\xef\xbb\xbf# 已有正文\r\n保持原样  ")
	if err := os.WriteFile(a.welcomePath(u.ID), original, 0600); err != nil {
		t.Fatal(err)
	}
	a.mustStart()
	a.restart(true)
	if got, err := os.ReadFile(a.welcomePath(u.ID)); err != nil || !bytes.Equal(got, original) {
		t.Fatalf("初始化覆盖同名原文：%q %v", got, err)
	}
	if err := os.Remove(a.welcomePath(u.ID)); err != nil {
		t.Fatal(err)
	}
	a.restart(true)
	if _, err := os.Lstat(a.welcomePath(u.ID)); !os.IsNotExist(err) {
		t.Fatalf("保留已有正文后未记录初始化完成：%v", err)
	}
}

func TestDemoSeedRejectsUnsafeWelcome(t *testing.T) {
	for _, kind := range []string{"symlink", "hardlink", "directory", "socket"} {
		t.Run(kind, func(t *testing.T) {
			a := newDemoTestApp(t, true)
			u, _, err := a.accounts.ConfigureDemo(true)
			if err != nil {
				t.Fatal(err)
			}
			path := a.welcomePath(u.ID)
			if err := os.Mkdir(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			outside := filepath.Join(t.TempDir(), "outside.md")
			original := []byte("外部原文\r\n")
			if err := os.WriteFile(outside, original, 0600); err != nil {
				t.Fatal(err)
			}
			if kind == "symlink" {
				if err := os.Symlink(outside, path); err != nil {
					t.Skipf("当前平台无法创建符号链接：%v", err)
				}
			} else if kind == "hardlink" {
				if err := os.Link(outside, path); err != nil { t.Skipf("当前平台无法创建硬链接：%v", err) }
			} else if kind == "socket" {
				listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
				if err != nil {
					t.Skipf("当前平台无法创建 Unix socket：%v", err)
				}
				listener.SetUnlinkOnClose(false)
				t.Cleanup(func() { listener.Close() })
			} else if err := os.Mkdir(path, 0700); err != nil {
				t.Fatal(err)
			}
			if err := a.start(); err == nil {
				t.Fatal("初始化接受了不安全的同名条目")
			}
			if got, err := os.ReadFile(outside); err != nil || !bytes.Equal(got, original) {
				t.Fatalf("失败初始化破坏了外部正文：%q %v", got, err)
			}
			if _, seeded, err := a.accounts.ConfigureDemo(true); err != nil || seeded {
				t.Fatalf("失败初始化错误标记为完成：seeded=%v err=%v", seeded, err)
			}
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
			a.mustStart()
			if _, err := os.ReadFile(path); err != nil {
				t.Fatalf("移除不安全条目后无法恢复初始化：%v", err)
			}
		})
	}
}

func TestDemoQuotaEnforcesActual100MiB(t *testing.T) {
	a := newDemoTestApp(t, true)
	a.mustStart()
	s := a.login("folio", "folio")
	entry, err := a.handler.get(s.ID)
	if err != nil {
		t.Fatal(err)
	}
	usage, err := entry.store.Usage()
	if err != nil || usage.Quota != 100<<20 || usage.Used <= 0 {
		t.Fatalf("初始实际用量错误：%+v %v", usage, err)
	}
	// 稀疏文件只占少量物理空间，仍由 Store 的真实逻辑字节统计计费。
	f, err := os.Create(filepath.Join(a.cfg.Workspace, strconv.FormatInt(s.ID, 10), "quota-fixture.bin"))
	if err != nil {
		t.Fatal(err)
	}
	err = f.Truncate((100 << 20) - usage.Used - 512)
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		t.Fatalf("创建稀疏配额样本：%v %v", err, closeErr)
	}
	usage, err = entry.store.Usage()
	if err != nil || usage.Used != (100<<20)-512 || usage.Quota != 100<<20 {
		t.Fatalf("稀疏文件未纳入实际配额：%+v %v", usage, err)
	}
	demoTestStatus(t, a.call(s, "POST", "/files", map[string]string{"path": "too-large.txt", "content": strings.Repeat("x", 1024)}), 413, "quota_exceeded")
	if _, err := os.Lstat(filepath.Join(filepath.Dir(a.welcomePath(s.ID)), "too-large.txt")); !os.IsNotExist(err) {
		t.Fatalf("配额拒绝后留下了文件：%v", err)
	}
	demoTestStatus(t, a.call(s, "POST", "/files", map[string]string{"path": "fits.txt", "content": strings.Repeat("x", 512)}), 201, "")
	demoTestStatus(t, a.call(s, "POST", "/files", map[string]string{"path": "one-more.txt", "content": "x"}), 413, "quota_exceeded")
}

func TestDemoModeOffRevokesOnlyDemoCredentials(t *testing.T) {
	a := newDemoTestApp(t, true)
	a.mustStart()
	demo := a.login("folio", "folio")
	admin := a.login("admin", demoTestAdminPassword)
	entry, err := a.handler.get(demo.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, secret, err := a.accounts.CreateAccessToken(demo.ID, entry.id, "demo-reader", 0, auth.TokenPermissions{Files: "read", Search: "none", Trash: "none"})
	if err != nil {
		t.Fatal(err)
	}
	readToken := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "/api/v1/workspace/tree", nil)
		r.Header.Set("Authorization", "Bearer "+secret)
		w := httptest.NewRecorder()
		a.handler.ServeHTTP(w, r)
		return w
	}
	demoTestStatus(t, readToken(), 200, "")
	original, err := os.ReadFile(a.welcomePath(demo.ID))
	if err != nil {
		t.Fatal(err)
	}
	a.restart(false)
	demoTestStatus(t, a.call(demo, "GET", "/auth/me", nil), 401, "")
	demoTestStatus(t, readToken(), 401, "")
	demoTestStatus(t, a.call(admin, "GET", "/auth/me", nil), 200, "")
	demoTestStatus(t, a.call(demoTestSession{}, "POST", "/auth/login", map[string]string{"username": "folio", "password": "folio"}), 401, "")
	if u := a.demoUser(); u.Enabled || u.ID != demo.ID {
		t.Fatalf("关闭模式未禁用原演示账号：%+v", u)
	}
	if got, err := os.ReadFile(a.welcomePath(demo.ID)); err != nil || !bytes.Equal(got, original) {
		t.Fatalf("关闭模式删除或改写了正文：%v", err)
	}
	if err := os.Remove(a.welcomePath(demo.ID)); err != nil {
		t.Fatal(err)
	}
	a.restart(true)
	if s := a.login("folio", "folio"); s.ID != demo.ID {
		t.Fatal("重开模式改变账号身份")
	}
	demoTestStatus(t, a.call(demo, "GET", "/auth/me", nil), 401, "")
	demoTestStatus(t, readToken(), 401, "")
	demoTestStatus(t, a.call(admin, "GET", "/auth/me", nil), 200, "")
	if _, err := os.Lstat(a.welcomePath(demo.ID)); !os.IsNotExist(err) {
		t.Fatalf("重开模式复活已删除介绍：%v", err)
	}
}
