package httpapi

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

type operationSummary struct {
	OperationID string            `json:"operationId"`
	Method      string            `json:"method"`
	Path        string            `json:"path"`
	Summary     string            `json:"summary"`
	Permissions map[string]string `json:"permissions"`
	Public      bool              `json:"public"`
	Contract    string            `json:"contract"`
}

type operationIndex struct {
	APIVersion string             `json:"apiVersion"`
	BasePath   string             `json:"basePath"`
	Guide      string             `json:"guide"`
	OpenAPI    string             `json:"openapi"`
	Operations []operationSummary `json:"operations"`
}

type applicationDocuments struct {
	index     []byte
	contracts map[string][]byte
}

var applicationOperationDocuments = func() applicationDocuments {
	documents, err := buildApplicationDocuments(applicationSpecification)
	if err != nil {
		panic(fmt.Errorf("应用 API 静态契约无效：%w", err))
	}
	return documents
}()

func isApplicationDocumentation(path string) bool {
	return path == "/api/v1/openapi.json" || path == "/api/v1/agent.md" || path == "/api/v1/operations" || strings.HasPrefix(path, "/api/v1/operations/")
}

// 索引及详情仅派生自嵌入契约，预先生成不可变字节，不读取部署配置或工作区。
func buildApplicationDocuments(source []byte) (applicationDocuments, error) {
	var spec map[string]any
	if err := json.Unmarshal(source, &spec); err != nil {
		return applicationDocuments{}, err
	}
	paths, ok := spec["paths"].(map[string]any)
	if !ok {
		return applicationDocuments{}, fmt.Errorf("缺少 paths")
	}
	index := operationIndex{APIVersion: "v1", BasePath: "/api/v1", Guide: "/api/v1/agent.md", OpenAPI: "/api/v1/openapi.json", Operations: []operationSummary{}}
	documents := applicationDocuments{contracts: map[string][]byte{}}
	for path, rawPath := range paths {
		item, ok := rawPath.(map[string]any)
		if !ok {
			return applicationDocuments{}, fmt.Errorf("无效路径定义 %s", path)
		}
		for _, method := range []string{"get", "put", "post", "delete", "options", "head", "patch", "trace"} {
			value, exists := item[method]
			if !exists {
				continue
			}
			op, ok := value.(map[string]any)
			if !ok {
				return applicationDocuments{}, fmt.Errorf("无效操作 %s %s", method, path)
			}
			id, _ := op["operationId"].(string)
			if id == "" || documents.contracts[id] != nil || strings.ContainsAny(id, "/?#%") {
				return applicationDocuments{}, fmt.Errorf("缺失、重复或不安全的 operationId %q", id)
			}
			permissions := map[string]string{}
			if raw, exists := op["x-folio-permissions"]; exists {
				encoded, err := json.Marshal(raw)
				if err != nil {
					return applicationDocuments{}, err
				}
				if err := json.Unmarshal(encoded, &permissions); err != nil || permissions == nil {
					return applicationDocuments{}, fmt.Errorf("操作 %s 的权限定义无效", id)
				}
			}
			security := spec["security"]
			if override, exists := op["security"]; exists {
				security = override
			}
			requirements, _ := security.([]any)
			public := len(requirements) == 0
			for _, requirement := range requirements {
				if entry, ok := requirement.(map[string]any); ok && len(entry) == 0 {
					public = true
				}
			}
			summary, _ := op["summary"].(string)
			index.Operations = append(index.Operations, operationSummary{id, strings.ToUpper(method), path, summary, permissions, public, "/api/v1/operations/" + id})
			selectedPath := map[string]any{method: op}
			for _, key := range []string{"summary", "description", "servers", "parameters"} {
				if inherited, exists := item[key]; exists {
					selectedPath[key] = inherited
				}
			}
			selected := map[string]any{"openapi": spec["openapi"], "info": spec["info"], "paths": map[string]any{path: selectedPath}}
			for _, key := range []string{"servers", "security"} {
				if inherited, exists := spec[key]; exists {
					selected[key] = inherited
				}
			}
			components, err := operationComponents(spec, selected)
			if err != nil {
				return applicationDocuments{}, fmt.Errorf("操作 %s：%w", id, err)
			}
			selected["components"] = components
			encoded, err := json.Marshal(selected)
			if err != nil {
				return applicationDocuments{}, err
			}
			documents.contracts[id] = encoded
		}
	}
	sort.Slice(index.Operations, func(i, j int) bool { return index.Operations[i].OperationID < index.Operations[j].OperationID })
	encoded, err := json.Marshal(index)
	documents.index = encoded
	return documents, err
}

func operationComponents(spec, selected map[string]any) (map[string]any, error) {
	source, _ := spec["components"].(map[string]any)
	result := map[string]any{}
	seen := map[string]bool{}
	var walk func(any) error
	var include func(string, string) error
	include = func(group, name string) error {
		key := group + "/" + name
		if seen[key] {
			return nil
		}
		entries, _ := source[group].(map[string]any)
		value, exists := entries[name]
		if !exists {
			return fmt.Errorf("未找到组件 %s", key)
		}
		seen[key] = true
		if result[group] == nil {
			result[group] = map[string]any{}
		}
		result[group].(map[string]any)[name] = value
		return walk(value)
	}
	walk = func(value any) error {
		switch node := value.(type) {
		case map[string]any:
			if raw, exists := node["$ref"]; exists {
				ref, ok := raw.(string)
				if !ok || !strings.HasPrefix(ref, "#/components/") {
					return fmt.Errorf("仅支持本地组件引用 %v", raw)
				}
				parts := strings.Split(strings.TrimPrefix(ref, "#/components/"), "/")
				if len(parts) < 2 {
					return fmt.Errorf("无效组件引用 %s", ref)
				}
				decode := strings.NewReplacer("~1", "/", "~0", "~")
				if err := include(decode.Replace(parts[0]), decode.Replace(parts[1])); err != nil {
					return err
				}
			}
			for _, child := range node {
				if err := walk(child); err != nil {
					return err
				}
			}
		case []any:
			for _, child := range node {
				if err := walk(child); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := walk(selected); err != nil {
		return nil, err
	}
	// security requirement 通过名称而非 $ref 引用认证方式。
	if security, ok := selected["security"].([]any); ok {
		for _, raw := range security {
			if requirement, ok := raw.(map[string]any); ok {
				for name := range requirement {
					if err := include("securitySchemes", name); err != nil {
						return nil, err
					}
				}
			}
		}
	}
	// 单操作也可能覆盖顶层 security。
	if paths, ok := selected["paths"].(map[string]any); ok {
		for _, raw := range paths {
			item := raw.(map[string]any)
			for _, raw := range item {
				if operation, ok := raw.(map[string]any); ok {
					if security, ok := operation["security"].([]any); ok {
						for _, raw := range security {
							if requirement, ok := raw.(map[string]any); ok {
								for name := range requirement {
									if err := include("securitySchemes", name); err != nil {
										return nil, err
									}
								}
							}
						}
					}
				}
			}
		}
	}
	return result, nil
}
