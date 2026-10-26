package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"folio/internal/auth"
)

func TestApplicationContractMatchesAuthorization(t *testing.T) {
	var spec struct {
		OpenAPI string `json:"openapi"`
		Paths   map[string]map[string]struct {
			OperationID string            `json:"operationId"`
			Permissions map[string]string `json:"x-folio-permissions"`
		} `json:"paths"`
	}
	if err := json.Unmarshal(applicationSpecification, &spec); err != nil {
		t.Fatal(err)
	}
	if spec.OpenAPI != "3.1.0" {
		t.Fatal(spec.OpenAPI)
	}
	seen := map[string]bool{}
	for path, methods := range spec.Paths {
		for method, op := range methods {
			if op.OperationID == "" || seen[op.OperationID] {
				t.Fatal("缺失或重复操作 ID", path, method)
			}
			seen[op.OperationID] = true
			if path == "/openapi.json" || path == "/agent.md" {
				continue
			}
			key := strings.ToUpper(method) + " " + path
			permission, ok := applicationRoutes[key]
			if !ok {
				t.Fatal("契约暴露了未授权路由", key)
			}
			required := map[string]string{}
			if permission.Group != "application" {
				level := "read"
				if permission.Write {
					level = "write"
				}
				required[permission.Group] = level
				if permission.Group == "trash" && permission.Write {
					required["files"] = "write"
				}
			}
			if len(required) != len(op.Permissions) {
				t.Fatal("权限契约不符", key)
			}
			for name, value := range required {
				if op.Permissions[name] != value {
					t.Fatal("权限契约不符", key, name)
				}
			}
		}
	}
	for key := range applicationRoutes {
		method, path, _ := strings.Cut(key, " ")
		if _, ok := spec.Paths[path][strings.ToLower(method)]; !ok {
			t.Fatal("令牌路由缺少契约", key)
		}
	}
}
func TestApplicationSpecificationIsPublicAndStatic(t *testing.T) {
	handler := New(fstest.MapFS{"index.html": {Data: []byte("Folio")}}, Options{})
	for _, credential := range []string{"", "Bearer invalid"} {
		r := httptest.NewRequest("GET", "/api/v1/openapi.json", nil)
		r.Header.Set("Authorization", credential)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 200 || w.Body.String() != string(applicationSpecification) || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Set-Cookie") != "" {
			t.Fatal(w.Code, w.Header())
		}
	}
}
func TestHeadUsesGetTokenPermission(t *testing.T) {
	read := &auth.AccessToken{Permissions: auth.TokenPermissions{Files: "read", Search: "none", Trash: "none"}}
	if !authorizeToken(read, httptest.NewRequest("HEAD", "/api/v1/files/download?path=note.txt", nil)) {
		t.Fatal("只读 HEAD 被拒绝")
	}
	if authorizeToken(read, httptest.NewRequest("HEAD", "/api/v1/user/tokens", nil)) {
		t.Fatal("HEAD 绕过管理边界")
	}
	if authorizeToken(read, httptest.NewRequest("HEAD", "/api/v1/search", nil)) {
		t.Fatal("HEAD 绕过搜索权限")
	}
}

func TestAgentGuideIsPublicWithoutOpeningWorkspace(t *testing.T) {
	handler := &Accounts{base: New(fstest.MapFS{}, Options{})}
	server := httptest.NewServer(handler)
	defer server.Close()
	for _, method := range []string{"GET", "HEAD"} {
		for _, credential := range []string{"", "Bearer invalid", "Bearer folio_" + strings.Repeat("a", 64)} {
			req, _ := http.NewRequest(method, server.URL+"/api/v1/agent.md", nil)
			req.Header.Set("Authorization", credential)
			resp, err := server.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil || resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/markdown; charset=utf-8" || resp.Header.Get("Cache-Control") != "no-store" || resp.Header.Get("X-Content-Type-Options") != "nosniff" || resp.Header.Get("Set-Cookie") != "" {
				t.Fatal(method, resp.StatusCode, resp.Header, err)
			}
			if method == "GET" && string(body) != string(applicationAgentGuide) {
				t.Fatal("指南与嵌入源不一致")
			}
			if method == "HEAD" && len(body) != 0 {
				t.Fatal("HEAD 返回正文")
			}
		}
	}
}
