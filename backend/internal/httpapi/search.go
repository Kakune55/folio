package httpapi

import (
	"context"
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
				writeError(w, 400, "invalid_request", "结果条数须为 1 到 200", nil)
				return
			}
			limit = value
		}
		if (mode != "" && mode != "names") || strings.ContainsRune(query, 0) || !utf8.ValidString(query) || utf8.RuneCountInString(query) > 200 {
			writeError(w, 400, "invalid_request", "搜索参数无效，查询最多 200 字符", nil)
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
