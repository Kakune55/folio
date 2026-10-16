package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"folio/internal/auth"
)

var protectedRoutes = []struct{ method, path string }{
	{"GET", "/api/v1/auth/me"}, {"POST", "/api/v1/auth/logout"},
	{"GET", "/api/v1/workspace/tree"}, {"GET", "/api/v1/files/content"},
	{"GET", "/api/v1/files/revision"}, {"GET", "/api/v1/files/metadata"},
	{"GET", "/api/v1/files/download"}, {"GET", "/api/v1/files/preview"},
	{"GET", "/api/v1/settings"}, {"GET", "/api/v1/entries/revision"},
	{"GET", "/api/v1/trash"}, {"GET", "/api/v1/search"},
	{"GET", "/api/v1/search/status"}, {"POST", "/api/v1/search/rebuild"},
	{"PUT", "/api/v1/files/content"}, {"POST", "/api/v1/files"},
	{"POST", "/api/v1/directories"}, {"POST", "/api/v1/uploads"},
	{"PATCH", "/api/v1/entries/move"}, {"DELETE", "/api/v1/entries"},
	{"POST", "/api/v1/trash/00000000000000000000000000000000/restore"},
}

func TestEveryPrivateRouteRequiresSessionBeforeStorage(t *testing.T) {
	// 不提供存储对象：任何绕开中间件的私有路由都会导致本测试失败。
	handler := New(fstest.MapFS{}, Options{})
	for _, route := range protectedRoutes {
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			for _, method := range []string{route.method, "HEAD"} {
				if method == "HEAD" && route.method != "GET" {
					continue
				}
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, httptest.NewRequest(method, route.path, nil))
				if response.Code != 401 || response.Header().Get("Cache-Control") != "no-store" {
					t.Fatalf("私有路由未鉴权/禁止缓存：%d %s", response.Code, response.Body.String())
				}
				if response.Header().Get("Access-Control-Allow-Origin") != "" {
					t.Fatal("私有接口开放了跨域读取")
				}
			}
		})
	}
}

func TestMutationsRejectBadOriginAndCSRFBeforeStorage(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "app-data")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	accounts, err := auth.Open(dir, "安全边界测试-123456")
	if err != nil {
		t.Fatal(err)
	}
	defer accounts.Close()
	token, principal, err := accounts.Login("admin", "安全边界测试-123456", "", "local")
	if err != nil {
		t.Fatal(err)
	}
	handler := New(fstest.MapFS{}, Options{Auth: accounts, Origin: "https://folio.example", SecureCookie: true})
	for _, route := range protectedRoutes {
		if route.method == "GET" {
			continue
		}
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			for _, probe := range []struct{ origin, csrf, site string }{
				{"https://evil.example", principal.CSRF, ""},
				{"null", principal.CSRF, ""},
				{"https://folio.example", "", ""},
				{"https://folio.example", "wrong-csrf", ""},
				{"", principal.CSRF, "cross-site"},
			} {
				request := httptest.NewRequest(route.method, route.path, strings.NewReader("{}"))
				request.AddCookie(&http.Cookie{Name: cookieName, Value: token})
				request.Header.Set("Origin", probe.origin)
				request.Header.Set("X-CSRF-Token", probe.csrf)
				request.Header.Set("Sec-Fetch-Site", probe.site)
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, request)
				if response.Code != 403 {
					t.Fatalf("来源/CSRF 不合法仍进入业务：%d %s", response.Code, response.Body.String())
				}
			}
		})
	}
	for _, origin := range []string{"https://evil.example", "null"} {
		request := httptest.NewRequest("POST", "/api/v1/auth/login", strings.NewReader("{}"))
		request.Header.Set("Origin", origin)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != 403 || len(response.Result().Cookies()) != 0 {
			t.Fatal("登录来源校验失败")
		}
	}
}

func TestConcurrentLoginReturnsBusyWithoutHashQueue(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "app-data")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	accounts, err := auth.Open(dir, "并发校验测试-123456")
	if err != nil {
		t.Fatal(err)
	}
	defer accounts.Close()
	handler := New(fstest.MapFS{}, Options{Auth: accounts, Origin: "https://folio.example"})
	start := make(chan struct{})
	type result struct {
		status int
		retry  string
	}
	results := make(chan result, 8)
	for i := 0; i < 8; i++ {
		go func() {
			<-start
			request := httptest.NewRequest("POST", "/api/v1/auth/login", strings.NewReader(`{"username":"admin","password":"并发校验测试-123456"}`))
			request.Header.Set("Origin", "https://folio.example")
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			results <- result{response.Code, response.Header().Get("Retry-After")}
		}()
	}
	close(start)
	success, busy := 0, 0
	for i := 0; i < 8; i++ {
		value := <-results
		switch {
		case value.status == 200:
			success++
		case value.status == 429 && value.retry == "1":
			busy++
		default:
			t.Errorf("突发登录响应异常：%+v", value)
		}
	}
	if success != 1 || busy != 7 {
		t.Fatalf("高成本校验未限为一个在途请求：成功 %d，忙时 %d", success, busy)
	}
}
