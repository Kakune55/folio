package httpapi

import (
	"context"
	"errors"
	"folio/internal/search"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

func (a *api) registerSearch(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/search", a.protect(func(w http.ResponseWriter, r *http.Request) {
		if a.Search == nil {
			writeError(w, 503, "index_unavailable", "搜索索引暂时不可用，文件编辑不受影响", nil)
			return
		}
		query := r.URL.Query().Get("q")
		mode := r.URL.Query().Get("mode")
		limit := 50
		if raw := r.URL.Query().Get("limit"); raw != "" {
			value, err := strconv.Atoi(raw)
			if err != nil || value < 1 || value > 200 {
				writeError(w, 400, "invalid_request", "结果条数须为 1 到 200 的整数", map[string]any{"field": "limit", "constraint": "1..200"})
				return
			}
			limit = value
		}
		if field, constraint, message := searchValidationError(query, mode, limit); message != "" {
			if field == "query" {
				field = "q"
			}
			writeError(w, 400, "invalid_request", message, map[string]any{"field": field, "constraint": constraint})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		results, err := a.Search.Query(ctx, query, mode, limit)
		if err != nil {
			writeError(w, 503, "index_unavailable", "搜索索引暂时不可用，请重试或重建；文件编辑不受影响", nil)
			return
		}
		writeJSON(w, 200, results)
	}))
	mux.HandleFunc("GET /api/v1/search/file-status", a.protect(func(w http.ResponseWriter, r *http.Request) {
		if a.Search == nil {
			writeError(w, 503, "index_unavailable", "搜索索引暂时不可用", nil)
			return
		}
		if len(r.URL.Query().Get("revision")) > 80 {
			writeError(w, 400, "invalid_request", "文件版本参数无效", nil)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		result, err := a.Search.FileState(ctx, r.URL.Query().Get("path"), r.URL.Query().Get("revision"))
		if err != nil {
			if errors.Is(err, search.ErrUnavailable) {
				writeError(w, 503, "index_unavailable", "搜索索引暂时不可用，请重建索引", nil)
			} else {
				storageError(w, err)
			}
			return
		}
		writeJSON(w, 200, result)
	}))
	mux.HandleFunc("GET /api/v1/search/status", a.protect(func(w http.ResponseWriter, r *http.Request) {
		if a.Search == nil {
			writeError(w, 503, "index_unavailable", "搜索服务未配置", nil)
			return
		}
		writeJSON(w, 200, a.Search.Status())
	}))
	mux.HandleFunc("POST /api/v1/search/rebuild", a.protect(func(w http.ResponseWriter, r *http.Request) {
		if a.Search == nil {
			writeError(w, 503, "index_unavailable", "搜索服务未配置", nil)
			return
		}
		a.Search.Refresh(true)
		writeJSON(w, 202, map[string]bool{"accepted": true})
	}))
}

func searchValidationError(query, mode string, limit int) (field, constraint, message string) {
	switch {
	case limit < 1 || limit > 200:
		return "limit", "1..200", "结果条数须为 1 到 200 的整数"
	case mode != "" && mode != "names":
		return "mode", "names or empty", "mode 仅支持 names 或省略"
	case !utf8.ValidString(query) || strings.ContainsRune(query, 0):
		return "query", "utf8_without_nul", "关键词须为有效 UTF-8 且不含空字符"
	case utf8.RuneCountInString(query) > 200:
		return "query", "at_most_200_characters", "关键词最多 200 字符"
	default:
		return "", "", ""
	}
}
