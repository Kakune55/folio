package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestM0Routes(t *testing.T) {
	handler := New(fstest.MapFS{"index.html": {Data: []byte("<!doctype html><html lang=\"zh-CN\">Folio</html>")}}, Options{})
	for _, tc := range []struct {
		path   string
		status int
		body   string
	}{
		{"/api/v1/healthz", 200, `"status":"ok"`},
		{"/api/v1/files/revision?path=secret.md", 401, `"code":"unauthenticated"`},
		{"/api/v1/files/content?path=secret.md", 401, `"code":"unauthenticated"`},
		{"/", 200, "Folio"},
		{"/missing.js", 404, "404"},
	} {
		t.Run(tc.path, func(t *testing.T) {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest("GET", tc.path, nil))
			if response.Code != tc.status || !strings.Contains(response.Body.String(), tc.body) {
				t.Fatalf("非预期响应：%d %s", response.Code, response.Body.String())
			}
			if response.Header().Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(response.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
				t.Fatal("缺少安全响应头")
			}
		})
	}
}
