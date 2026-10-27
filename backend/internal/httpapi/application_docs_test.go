package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
)

func TestOperationDocumentsMatchEmbeddedSource(t *testing.T) {
	var source map[string]any
	if err := json.Unmarshal(applicationSpecification, &source); err != nil {
		t.Fatal(err)
	}
	var index operationIndex
	if err := json.Unmarshal(applicationOperationDocuments.index, &index); err != nil {
		t.Fatal(err)
	}
	if index.BasePath != "/api/v1" || index.Guide != "/api/v1/agent.md" || index.OpenAPI != "/api/v1/openapi.json" {
		t.Fatal(index)
	}
	count := 0
	paths := source["paths"].(map[string]any)
	for _, raw := range paths {
		count += len(raw.(map[string]any))
	}
	if len(index.Operations) != count || len(applicationOperationDocuments.contracts) != count {
		t.Fatal("操作索引未完整派生", len(index.Operations), count)
	}
	previous := ""
	for _, entry := range index.Operations {
		if entry.OperationID <= previous || entry.Contract != "/api/v1/operations/"+entry.OperationID {
			t.Fatal("操作索引顺序或入口不稳定", entry)
		}
		previous = entry.OperationID
		op := paths[entry.Path].(map[string]any)[strings.ToLower(entry.Method)].(map[string]any)
		if op["operationId"] != entry.OperationID || op["summary"] != entry.Summary {
			t.Fatal("操作摘要与契约不一致", entry)
		}
		permissions := map[string]string{}
		if raw, exists := op["x-folio-permissions"]; exists {
			encoded, _ := json.Marshal(raw)
			if err := json.Unmarshal(encoded, &permissions); err != nil {
				t.Fatal(err)
			}
		}
		if !reflect.DeepEqual(permissions, entry.Permissions) {
			t.Fatal("权限不一致", entry)
		}
		if entry.Public != isApplicationDocumentation("/api/v1"+entry.Path) {
			t.Fatal("公开接口边界不一致", entry)
		}
		var detail map[string]any
		if err := json.Unmarshal(applicationOperationDocuments.contracts[entry.OperationID], &detail); err != nil {
			t.Fatal(err)
		}
		selected := detail["paths"].(map[string]any)
		if len(selected) != 1 || !reflect.DeepEqual(selected[entry.Path].(map[string]any)[strings.ToLower(entry.Method)], op) {
			t.Fatal("单操作契约不一致", entry)
		}
		for _, key := range []string{"openapi", "info", "servers", "security"} {
			if !reflect.DeepEqual(detail[key], source[key]) {
				t.Fatal("继承字段丢失", entry.OperationID, key)
			}
		}
		if len(applicationOperationDocuments.contracts[entry.OperationID]) >= len(applicationSpecification) {
			t.Fatal("单操作未精简", entry.OperationID)
		}
	}
	if len(applicationAgentGuide) > 5*1024 || len(applicationOperationDocuments.index) > len(applicationSpecification)/3 {
		t.Fatal("渐进式入口体量过大", len(applicationAgentGuide), len(applicationOperationDocuments.index), len(applicationSpecification))
	}
	for _, required := range []string{"/operations/{operationId}", "If-Match", "412", "片段不能直接 PUT", "durability_uncertain", "数据", "凭据"} {
		if !strings.Contains(string(applicationAgentGuide), required) {
			t.Fatal("精简指南丢失关键约定", required)
		}
	}
	t.Logf("指南 %d 字节，索引 %d 字节，完整契约 %d 字节，读取详情 %d 字节，局部修改详情 %d 字节", len(applicationAgentGuide), len(applicationOperationDocuments.index), len(applicationSpecification), len(applicationOperationDocuments.contracts["readContent"]), len(applicationOperationDocuments.contracts["patchContent"]))
}

func TestOperationDocumentsArePublicWithoutWorkspace(t *testing.T) {
	handler := &Accounts{base: New(fstest.MapFS{}, Options{})}
	server := httptest.NewServer(handler)
	defer server.Close()
	paths := map[string][]byte{"/api/v1/operations": applicationOperationDocuments.index, "/api/v1/openapi.json": applicationSpecification}
	for id, body := range applicationOperationDocuments.contracts {
		paths["/api/v1/operations/"+id] = body
	}
	for path, expected := range paths {
		for _, method := range []string{"GET", "HEAD"} {
			for _, credential := range []string{"", "Bearer invalid", "Bearer folio_" + strings.Repeat("a", 64)} {
				req, _ := http.NewRequest(method, server.URL+path, nil)
				req.Header.Set("Authorization", credential)
				req.Header.Set("Cookie", "folio_session=invalid")
				resp, err := server.Client().Do(req)
				if err != nil {
					t.Fatal(err)
				}
				body, readErr := io.ReadAll(resp.Body)
				resp.Body.Close()
				if readErr != nil || resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "application/json; charset=utf-8" || resp.Header.Get("Cache-Control") != "no-store" || resp.Header.Get("Set-Cookie") != "" || resp.Header.Get("X-Content-Type-Options") != "nosniff" {
					t.Fatal(method, path, resp.StatusCode, resp.Header, readErr)
				}
				if method == "HEAD" && len(body) != 0 || method == "GET" && !bytes.Equal(body, expected) {
					t.Fatal("响应与派生源不一致", method, path)
				}
			}
		}
	}
	for _, path := range []string{"/api/v1/operations/unknown", "/api/v1/operations/user/tokens"} {
		resp, err := server.Client().Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 404 || resp.Header.Get("Set-Cookie") != "" || bytes.Contains(body, []byte("password")) {
			t.Fatal(path, resp.StatusCode, string(body))
		}
	}
	for _, path := range []string{"/api/v1/application", "/api/v1/user/tokens", "/api/v1/operations-private"} {
		if isApplicationDocumentation(path) {
			t.Fatal("扩大了公开文档边界", path)
		}
	}
}

func TestOperationDocumentReferenceClosure(t *testing.T) {
	source := []byte(`{"openapi":"3.1.0","info":{"title":"测试","version":"1"},"servers":[{"url":"/api/v1"}],"security":[{"first":[]}],"paths":{"/test":{"parameters":[{"$ref":"#/components/parameters/path"}],"get":{"operationId":"test","summary":"测试","security":[{"second":[]}],"responses":{"200":{"description":"成功","content":{"application/json":{"schema":{"$ref":"#/components/schemas/A"}}}}}}}},"components":{"securitySchemes":{"first":{"type":"http","scheme":"bearer"},"second":{"type":"http","scheme":"basic"}},"parameters":{"path":{"name":"path","in":"query","schema":{"type":"string"}}},"schemas":{"A":{"type":"object","properties":{"next":{"$ref":"#/components/schemas/B"}}},"B":{"type":"object","properties":{"back":{"$ref":"#/components/schemas/A"}}},"Unused":{"type":"string"}}}}`)
	documents, err := buildApplicationDocuments(source)
	if err != nil {
		t.Fatal(err)
	}
	var selected map[string]any
	if err := json.Unmarshal(documents.contracts["test"], &selected); err != nil {
		t.Fatal(err)
	}
	components := selected["components"].(map[string]any)
	if len(components["schemas"].(map[string]any)) != 2 || len(components["securitySchemes"].(map[string]any)) != 2 || len(components["parameters"].(map[string]any)) != 1 {
		t.Fatal("递归引用、认证或路径继承缺失", components)
	}
	for _, invalid := range []string{
		strings.Replace(string(source), "#/components/schemas/B", "#/components/schemas/Missing", 1),
		strings.Replace(string(source), "#/components/schemas/B", "https://example.invalid/schema", 1),
		strings.Replace(string(source), `"operationId":"test"`, `"operationId":""`, 1),
	} {
		if _, err := buildApplicationDocuments([]byte(invalid)); err == nil {
			t.Fatal("未拒绝无效静态契约")
		}
	}
}
