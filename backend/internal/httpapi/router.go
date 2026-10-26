package httpapi

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"strings"
)

// 静态资源与 API 共享同源服务，所有文件操作均经过认证与 CSRF 边界。
func New(assets fs.FS, options Options) http.Handler {
	mux := http.NewServeMux()
	api := &api{Options: options}
	api.register(mux)
	mux.HandleFunc("GET /api/v1/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": "not_found", "message": "接口尚未实现"}})
	})
	static := http.FileServerFS(assets)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "请求方法不受支持", http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Path == "/" {
			if _, err := fs.Stat(assets, "index.html"); err != nil {
				http.Error(w, "前端尚未构建，请运行 make build", http.StatusServiceUnavailable)
				return
			}
		}
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		if r.URL.Path == "/user-setting" || r.URL.Path == "/system-setting" || r.URL.Path == "/shares" || strings.HasPrefix(r.URL.Path, "/s/") {
			clone := r.Clone(r.Context())
			url := *r.URL
			url.Path = "/"
			clone.URL = &url
			static.ServeHTTP(w, clone)
			return
		}
		static.ServeHTTP(w, r)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if strings.HasPrefix(r.URL.Path, "/s/") || strings.HasPrefix(r.URL.Path, "/api/v1/public/") {
			w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
		}
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		mux.ServeHTTP(w, r)
	})
}
