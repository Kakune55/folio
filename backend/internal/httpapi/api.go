package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"folio/internal/auth"
	"folio/internal/search"
	"folio/internal/storage"
)

type Options struct {
	Search       *search.Index
	Auth         *auth.Service
	Workspace    *storage.Store
	SecureCookie bool
	Origin       string
}
type api struct{ Options }

const cookieName = "folio_session"

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}
func writeError(w http.ResponseWriter, status int, code, message string, details any) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"code": code, "message": message, "details": details}})
}
func storageError(w http.ResponseWriter, err error) {
	var problem *storage.Error
	if !errors.As(err, &problem) {
		log.Printf("文件操作失败：%v", err)
		writeError(w, 500, "internal_error", "文件操作失败，草稿已保留，请检查服务日志和磁盘状态", nil)
		return
	}
	statuses := map[string]int{"path_invalid": 400, "not_found": 404, "target_exists": 409, "forbidden": 403, "unsupported_file_type": 415, "too_large": 413, "revision_conflict": 412, "precondition_required": 428, "file_changed": 409, "durability_uncertain": 500, "preview_unavailable": 415, "operation_in_progress": 409, "trash_unavailable": 503, "trash_damaged": 422, "trash_failed": 500, "trash_incomplete": 500}
	messages := map[string]string{"operation_in_progress": "文件正在上传，或目录包含未完成的临时/不支持条目，请稍后检查再操作", "trash_unavailable": "回收站尚未配置", "trash_damaged": "恢复记录或副本损坏，请保留记录并检查应用数据目录", "trash_failed": "操作未完成，原文件或恢复副本仍保留，请检查后重试", "trash_incomplete": "回收站操作未完成，恢复记录与隔离原件已保留，请打开回收站恢复或联系管理员检查", "path_invalid": "路径不安全或不受支持", "not_found": "文件或目录不存在", "target_exists": "同名文件或目录已存在", "forbidden": "没有操作权限", "unsupported_file_type": "仅支持普通 UTF-8 文本，拒绝特殊文件及硬链接", "too_large": "文件超过此类型的大小限制", "revision_conflict": "文件已被其他编辑器修改，请比较两个版本", "preview_unavailable": "此文件不支持安全预览或超过预览限制，请下载查看", "precondition_required": "保存必须携带读取时的版本", "file_changed": "读取或操作期间文件发生变化，请重试", "durability_uncertain": "操作可能已应用，但目录同步未完成；请保留草稿并刷新文件列表/回收站确认"}
	status := statuses[problem.Code]
	if status == 0 {
		status = 500
	}
	if status >= 500 {
		log.Printf("文件操作未完成：%v", err)
	}
	writeError(w, status, problem.Code, messages[problem.Code], map[string]string{"currentRevision": problem.Revision})
}
func decodeJSON(w http.ResponseWriter, r *http.Request, limit int64, target any) bool {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		writeError(w, 415, "unsupported_media_type", "请使用 application/json", nil)
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	err = decoder.Decode(target)
	if err == nil {
		var extra any
		if next := decoder.Decode(&extra); next != io.EOF {
			if next == nil {
				err = errors.New("多个 JSON 值")
			} else {
				err = next
			}
		}
	}
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, 413, "too_large", "请求体过大", nil)
		} else {
			writeError(w, 400, "invalid_request", "JSON 请求格式不正确", nil)
		}
		return false
	}
	return true
}
func sessionToken(r *http.Request) string {
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		return ""
	}
	return cookie.Value
}
func (a *api) cookie(w http.ResponseWriter, value string, clear bool) {
	c := &http.Cookie{Name: cookieName, Value: value, Path: "/api/v1", HttpOnly: true, Secure: a.SecureCookie, SameSite: http.SameSiteStrictMode, MaxAge: int(auth.SessionLifetime.Seconds())}
	if clear {
		c.MaxAge = -1
		c.Expires = time.Unix(1, 0)
	}
	http.SetCookie(w, c)
}
func (a *api) allowedOrigin(r *http.Request) bool {
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	expected := a.Origin
	if expected == "" {
		scheme := "https"
		if !a.SecureCookie {
			scheme = "http"
		}
		expected = scheme + "://" + r.Host
	}
	return origin == expected
}
func (a *api) protect(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if a.Auth == nil {
			writeError(w, 401, "unauthenticated", "请先登录", nil)
			return
		}
		principal, err := a.Auth.Authenticate(sessionToken(r))
		if err != nil {
			if !errors.Is(err, auth.ErrCredentials) {
				writeError(w, 500, "internal_error", "认证服务暂时不可用，请保留当前草稿并稍后重试", nil)
				return
			}
			writeError(w, 401, "unauthenticated", "登录已过期，请重新登录；未保存草稿会保留在当前页面", nil)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if !a.allowedOrigin(r) || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(principal.CSRF)) != 1 {
				writeError(w, 403, "forbidden", "来源或 CSRF 校验失败", nil)
				return
			}
		}
		if a.Search != nil && r.Method != http.MethodGet && r.Method != http.MethodHead && !strings.HasPrefix(r.URL.Path, "/api/v1/auth/") && !strings.HasPrefix(r.URL.Path, "/api/v1/search/") {
			recorder := &statusRecorder{ResponseWriter: w, status: 200}
			next(recorder, r)
			if recorder.status >= 200 && recorder.status < 300 {
				a.Search.Refresh(false)
			}
			return
		}
		next(w, r)
	}
}
func (a *api) register(mux *http.ServeMux) {
	a.registerAttachments(mux)
	a.registerEntries(mux)
	a.registerSearch(mux)
	mux.HandleFunc("POST /api/v1/auth/login", func(w http.ResponseWriter, r *http.Request) {
		if a.Auth == nil {
			writeError(w, 503, "unavailable", "认证服务不可用", nil)
			return
		}
		if !a.allowedOrigin(r) {
			writeError(w, 403, "forbidden", "来源校验失败", nil)
			return
		}
		var body struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if !decodeJSON(w, r, 4096, &body) {
			return
		}
		if len(body.Username) > 128 || len(body.Password) > 1024 {
			writeError(w, 400, "invalid_request", "账号或密码过长", nil)
			return
		}
		remote, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			remote = r.RemoteAddr
		}
		token, principal, err := a.Auth.Login(body.Username, body.Password, sessionToken(r), remote)
		if errors.Is(err, auth.ErrCredentials) {
			writeError(w, 401, "unauthenticated", err.Error(), nil)
			return
		}
		if errors.Is(err, auth.ErrRateLimited) {
			w.Header().Set("Retry-After", "600")
			writeError(w, 429, "rate_limited", err.Error(), nil)
			return
		}
		if err != nil {
			writeError(w, 500, "internal_error", "登录失败，请稍后重试", nil)
			return
		}
		a.cookie(w, token, false)
		writeJSON(w, 200, principal)
	})
	mux.HandleFunc("GET /api/v1/auth/me", a.protect(func(w http.ResponseWriter, r *http.Request) {
		principal, err := a.Auth.Authenticate(sessionToken(r))
		if err != nil {
			writeError(w, 401, "unauthenticated", "请重新登录", nil)
			return
		}
		writeJSON(w, 200, principal)
	}))
	mux.HandleFunc("POST /api/v1/auth/logout", a.protect(func(w http.ResponseWriter, r *http.Request) {
		if err := a.Auth.Logout(sessionToken(r)); err != nil {
			writeError(w, 500, "internal_error", "退出失败，请重试", nil)
			return
		}
		a.cookie(w, "", true)
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("GET /api/v1/workspace/tree", a.protect(a.list))
	mux.HandleFunc("GET /api/v1/files/content", a.protect(func(w http.ResponseWriter, r *http.Request) {
		content, err := a.Workspace.Read(r.URL.Query().Get("path"))
		if err != nil {
			storageError(w, err)
			return
		}
		w.Header().Set("ETag", `"`+content.Revision+`"`)
		writeJSON(w, 200, content)
	}))
	mux.HandleFunc("GET /api/v1/files/revision", a.protect(func(w http.ResponseWriter, r *http.Request) {
		// 仅检查有编辑上限的普通文本；不递归散列被外部替换成目录的路径。
		content, err := a.Workspace.Read(r.URL.Query().Get("path"))
		if err != nil {
			storageError(w, err)
			return
		}
		w.Header().Set("ETag", `"`+content.Revision+`"`)
		writeJSON(w, 200, map[string]string{"path": content.Path, "revision": content.Revision})
	}))
	mux.HandleFunc("PUT /api/v1/files/content", a.protect(func(w http.ResponseWriter, r *http.Request) { a.write(w, r, false) }))
	mux.HandleFunc("POST /api/v1/files", a.protect(func(w http.ResponseWriter, r *http.Request) { a.write(w, r, true) }))
	mux.HandleFunc("POST /api/v1/directories", a.protect(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string `json:"path"`
		}
		if !decodeJSON(w, r, 8192, &body) {
			return
		}
		if err := a.Workspace.Mkdir(body.Path); err != nil {
			storageError(w, err)
			return
		}
		writeJSON(w, 201, map[string]string{"path": body.Path})
	}))
}
func (a *api) list(w http.ResponseWriter, r *http.Request) {
	offset, limit := 0, 200
	if r.URL.Query().Get("offset") != "" {
		if _, err := parseInt(r.URL.Query().Get("offset"), &offset); err != nil || offset < 0 {
			writeError(w, 400, "invalid_request", "分页参数不正确", nil)
			return
		}
	}
	if r.URL.Query().Get("limit") != "" {
		if _, err := parseInt(r.URL.Query().Get("limit"), &limit); err != nil || limit < 1 || limit > 1000 {
			writeError(w, 400, "invalid_request", "每页条数须为 1 到 1000", nil)
			return
		}
	}
	entries, total, err := a.Workspace.List(r.URL.Query().Get("path"), offset, limit)
	if err != nil {
		storageError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"entries": entries, "total": total, "offset": offset, "limit": limit})
}
func (a *api) write(w http.ResponseWriter, r *http.Request, create bool) {
	var body struct {
		Path     string `json:"path,omitempty"`
		Content  string `json:"content"`
		Encoding string `json:"encoding"`
	}
	// JSON 对控制字符的转义最多放大六倍，真正的正文限制仍由存储层执行。
	if !decodeJSON(w, r, a.Workspace.Limits().Text*6+16384, &body) {
		return
	}
	if body.Encoding != "" && body.Encoding != "utf-8" {
		writeError(w, 422, "invalid_encoding", "仅支持 UTF-8", nil)
		return
	}
	name := r.URL.Query().Get("path")
	if create {
		name = body.Path
	}
	revision := r.Header.Get("If-Match")
	if !create {
		if revision == "" {
			storageError(w, &storage.Error{Code: "precondition_required"})
			return
		}
		if !strings.HasPrefix(revision, `"sha256:`) || !strings.HasSuffix(revision, `"`) || strings.Contains(revision, ",") {
			writeError(w, 400, "invalid_request", "If-Match 必须为读取时返回的单个强 ETag", nil)
			return
		}
		revision = strings.Trim(revision, `"`)
	}
	newRevision, err := a.Workspace.Write(name, body.Content, revision, create)
	if err != nil {
		storageError(w, err)
		return
	}
	status := 200
	if create {
		status = 201
	}
	w.Header().Set("ETag", `"`+newRevision+`"`)
	writeJSON(w, status, map[string]string{"path": name, "revision": newRevision, "savedAt": time.Now().UTC().Format(time.RFC3339Nano)})
}

func parseInt(raw string, out *int) (int, error) {
	value, err := strconv.Atoi(raw)
	*out = value
	return value, err
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (w *statusRecorder) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusRecorder) Unwrap() http.ResponseWriter { return w.ResponseWriter }
