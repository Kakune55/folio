package httpapi

import (
	"net/http"
	"net/url"
)

// 根目录列表及上传目录可省略路径，不属于条目定位参数。
func validateQueryPath(w http.ResponseWriter, r *http.Request) bool {
	switch r.URL.Path {
	case "/api/v1/files/content", "/api/v1/files/revision", "/api/v1/files/metadata",
		"/api/v1/files/download", "/api/v1/files/preview", "/api/v1/entries/revision",
		"/api/v1/entries", "/api/v1/search/file-status":
		values, err := url.ParseQuery(r.URL.RawQuery)
		if err != nil {
			writeError(w, 400, "invalid_request", "查询参数编码不正确；请将工作区相对路径 URL 编码后放入 ?path=...", map[string]string{"expected": "query:path"})
			return false
		}
		return validatePathParameter(w, values.Get("path"), values.Has("path"), "query")
	default:
		return true
	}
}

func validatePathParameter(w http.ResponseWriter, value string, present bool, location string) bool {
	if value != "" {
		return true
	}
	message := "缺少必需的 query 参数 path；本操作要求 ?path=...，不能放在 JSON body 中"
	if location == "body" {
		message = "缺少必需的 JSON body 字符串字段 path；本操作要求在 JSON body 中提供，不能放在 query 中"
	}
	if present {
		message = "必需的 query 参数 path 不能为空；请使用 ?path=工作区相对路径"
		if location == "body" {
			message = "必需的 JSON body 字段 path 不能为空；请提供工作区相对路径"
		}
	}
	writeError(w, 400, "path_missing", message, map[string]string{"expected": location + ":path"})
	return false
}
