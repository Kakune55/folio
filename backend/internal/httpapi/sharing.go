package httpapi

import (
	"bytes"
	"errors"
	"log"
	"mime"
	"net"
	"net/http"
	"path"
	"time"

	"folio/internal/sharing"
	"folio/internal/storage"
)

func shareError(w http.ResponseWriter, err error) {
	var p *sharing.Error
	if errors.As(err, &p) {
		if p.Status == 429 {
			w.Header().Set("Retry-After", "60")
		}
		writeError(w, p.Status, "share_error", p.Message, nil)
		return
	}
	var e *storage.Error
	if errors.As(err, &e) {
		storageError(w, err)
		return
	}
	log.Printf("分享操作失败：%v", err)
	writeError(w, 500, "share_error", "分享操作未完成，请刷新管理列表核对结果并重试；不要删除原文件", nil)
}
func shareCookie(r *http.Request, id string) string {
	c, e := r.Cookie("folio_share_access")
	if e != nil {
		return ""
	}
	return c.Value
}
func (a *api) shareWork(w http.ResponseWriter, r *http.Request) bool {
	if a.Shares.StartWork(r.Context()) {
		return true
	}
	w.Header().Set("Retry-After", "2")
	writeError(w, 429, "rate_limited", "分享读取或复制繁忙，请稍后重试", nil)
	return false
}
func (a *api) registerSharing(mux *http.ServeMux) {
	if a.Shares == nil {
		return
	}
	mux.HandleFunc("GET /api/v1/shares", a.protect(func(w http.ResponseWriter, r *http.Request) {
		p, _ := a.Auth.Authenticate(sessionToken(r))
		offset, limit, ok := pagination(w, r)
		if !ok {
			return
		}
		if r.URL.Query().Get("limit") == "" {
			limit = 20
		}
		if limit > 50 {
			writeError(w, 400, "invalid_request", "分享每页最多 50 条", nil)
			return
		}
		records, total, err := a.Shares.List(p.ID, offset, limit)
		if err != nil {
			shareError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"entries": records, "total": total, "offset": offset, "limit": limit})
	}))
	mux.HandleFunc("POST /api/v1/shares/analyze", a.protect(func(w http.ResponseWriter, r *http.Request) {
		if !a.shareWork(w, r) {
			return
		}
		defer a.Shares.EndWork()
		var input struct {
			Root    string `json:"root"`
			Include bool   `json:"include"`
		}
		if !decodeJSON(w, r, 8192, &input) {
			return
		}
		scan, err := sharing.ScanFiles(a.Workspace, input.Root, input.Include)
		if err != nil {
			shareError(w, err)
			return
		}
		sharing.SortScan(&scan)
		writeJSON(w, 200, scan)
	}))
	save := a.protect(func(w http.ResponseWriter, r *http.Request) {
		if !a.shareWork(w, r) {
			return
		}
		defer a.Shares.EndWork()
		var input sharing.Input
		if !decodeJSON(w, r, 1<<20, &input) {
			return
		}
		p, _ := a.Auth.Authenticate(sessionToken(r))
		record, err := a.Shares.Save(p.ID, r.PathValue("id"), input)
		if err != nil {
			shareError(w, err)
			return
		}
		status := 200
		if r.PathValue("id") == "" {
			status = 201
		}
		writeJSON(w, status, record)
	})
	mux.HandleFunc("POST /api/v1/shares", save)
	mux.HandleFunc("PUT /api/v1/shares/{id}", save)
	mux.HandleFunc("DELETE /api/v1/shares/{id}", a.protect(func(w http.ResponseWriter, r *http.Request) {
		p, _ := a.Auth.Authenticate(sessionToken(r))
		if err := a.Shares.Delete(p.ID, r.PathValue("id")); err != nil {
			shareError(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	// 转存必须同时持有分享访问资格与当前接收账号的 CSRF，不能由公开 GET 触发写入。
	mux.HandleFunc("POST /api/v1/shares/{id}/import", a.protect(func(w http.ResponseWriter, r *http.Request) {
		if !a.shareWork(w, r) {
			return
		}
		defer a.Shares.EndWork()
		var input struct {
			File      string `json:"file"`
			Directory string `json:"directory"`
		}
		if !decodeJSON(w, r, 16384, &input) {
			return
		}
		p, _ := a.Auth.Authenticate(sessionToken(r))
		result, err := a.Shares.Import(r.PathValue("id"), shareCookie(r, r.PathValue("id")), input.File, p.ID, input.Directory)
		a.indexChange(r, err, result)
		if err != nil {
			shareError(w, err)
			return
		}
		writeJSON(w, 201, map[string]string{"path": result})
	}))
	mux.HandleFunc("GET /api/v1/public/shares/{id}", func(w http.ResponseWriter, r *http.Request) {
		protected, err := a.Shares.Info(r.PathValue("id"))
		if err != nil {
			shareError(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"protected": protected})
	})
	mux.HandleFunc("POST /api/v1/public/shares/{id}/enter", func(w http.ResponseWriter, r *http.Request) {
		if !a.allowedOrigin(r) {
			writeError(w, 403, "forbidden", "来源校验失败", nil)
			return
		}
		var input struct {
			Password string `json:"password"`
		}
		if !decodeJSON(w, r, 1024, &input) {
			return
		}
		if len(input.Password) > 6 {
			writeError(w, 400, "invalid_request", "请输入六位数字密码", nil)
			return
		}
		id := r.PathValue("id")
		remote, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			remote = r.RemoteAddr
		}
		record, token, err := a.Shares.Enter(id, input.Password, shareCookie(r, id), remote)
		if err != nil {
			shareError(w, err)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "folio_share_access", Value: token, Path: "/api/v1", HttpOnly: true, Secure: a.SecureCookie, SameSite: http.SameSiteStrictMode, MaxAge: int(sharing.GrantLifetime.Seconds())})
		writeJSON(w, 200, record)
	})
	mux.HandleFunc("GET /api/v1/public/shares/{id}/manifest", func(w http.ResponseWriter, r *http.Request) {
		record, err := a.Shares.Manifest(r.PathValue("id"), shareCookie(r, r.PathValue("id")))
		if err != nil {
			shareError(w, err)
			return
		}
		writeJSON(w, 200, record)
	})
	mux.HandleFunc("GET /api/v1/public/shares/{id}/files/{file}/{action}", func(w http.ResponseWriter, r *http.Request) {
		if !a.shareWork(w, r) {
			return
		}
		defer a.Shares.EndWork()
		id := r.PathValue("id")
		file, record, err := a.Shares.File(id, shareCookie(r, id), r.PathValue("file"))
		if err != nil {
			shareError(w, err)
			return
		}
		switch r.PathValue("action") {
		case "metadata":
			writeJSON(w, 200, file.Metadata)
		case "content":
			if file.Metadata.Viewer != "text" && file.Metadata.Viewer != "markdown" {
				writeError(w, 415, "unsupported_file_type", "此文件仅支持下载或附件预览", nil)
				return
			}
			rendered := ""
			if file.Metadata.Viewer == "markdown" {
				rendered, err = sharing.Render(file.Path, file.Data, id, record.Files)
				if err != nil {
					shareError(w, err)
					return
				}
			}
			writeJSON(w, 200, map[string]any{"metadata": file.Metadata, "content": string(file.Data), "html": rendered})
		case "preview", "download":
			preview := r.PathValue("action") == "preview"
			media := "application/octet-stream"
			disposition := "attachment"
			if preview {
				if file.Metadata.Viewer != "image" && file.Metadata.Viewer != "pdf" {
					writeError(w, 415, "preview_unavailable", "此文件不支持安全预览", nil)
					return
				}
				media = file.Metadata.MediaType
				disposition = "inline"
			}
			w.Header().Set("Content-Type", media)
			w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": path.Base(file.Path)}))
			w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox; frame-ancestors 'none'")
			w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
			http.ServeContent(w, r, path.Base(file.Path), time.Time{}, bytes.NewReader(file.Data))
		default:
			writeError(w, 404, "not_found", "分享操作不存在", nil)
		}
	})
}
