package httpapi

import (
	"database/sql"
	"errors"
	"log"
	"net/http"
	"strconv"

	"folio/internal/auth"
)

func userError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, auth.ErrUserInput):
		writeError(w, 400, "invalid_user", err.Error(), nil)
	case errors.Is(err, auth.ErrUsername):
		writeError(w, 409, "username_exists", err.Error(), nil)
	case errors.Is(err, auth.ErrCredentials):
		writeError(w, 403, "invalid_password", "原密码不正确", nil)
	case errors.Is(err, auth.ErrLoginBusy):
		w.Header().Set("Retry-After", "1")
		writeError(w, 429, "rate_limited", err.Error(), nil)
	case errors.Is(err, sql.ErrNoRows):
		writeError(w, 404, "not_found", "用户不存在", nil)
	default:
		log.Printf("用户操作失败：%v", err)
		writeError(w, 500, "internal_error", "用户操作失败，请重试或检查服务日志", nil)
	}
}
func (a *api) administrator(next http.HandlerFunc) http.HandlerFunc {
	return a.protect(func(w http.ResponseWriter, r *http.Request) {
		p, err := a.Auth.Authenticate(sessionToken(r))
		if err != nil || !p.Admin {
			writeError(w, 403, "forbidden", "仅管理员可以管理用户", nil)
			return
		}
		next(w, r)
	})
}
func (a *api) registerUsers(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/admin/users", a.administrator(func(w http.ResponseWriter, r *http.Request) {
		offset, limit, ok := pagination(w, r)
		if !ok {
			return
		}
		q := r.URL.Query().Get("q")
		if len(q) > 256 {
			writeError(w, 400, "invalid_request", "搜索内容过长", nil)
			return
		}
		users, total, err := a.Auth.Users(q, offset, limit)
		if err != nil {
			userError(w, err)
			return
		}
		type row struct {
			auth.User
			Used       *int64 `json:"used"`
			UsageError string `json:"usageError,omitempty"`
		}
		entries := []row{}
		for _, u := range users {
			item := row{User: u}
			if a.UserUsage != nil {
				usage, e := a.UserUsage(u.ID)
				if e != nil {
					item.UsageError = "用量读取失败"
				} else {
					item.Used = &usage.Used
				}
			}
			entries = append(entries, item)
		}
		writeJSON(w, 200, map[string]any{"entries": entries, "total": total, "offset": offset, "limit": limit})
	}))
	save := func(w http.ResponseWriter, r *http.Request) {
		id := int64(0)
		var err error
		if raw := r.PathValue("id"); raw != "" {
			id, err = strconv.ParseInt(raw, 10, 64)
			if err != nil || id < 1 {
				writeError(w, 400, "invalid_request", "用户编号无效", nil)
				return
			}
		}
		var input auth.UserInput
		if !decodeJSON(w, r, 8192, &input) {
			return
		}
		u, err := a.Auth.SaveUser(id, input)
		if err != nil {
			userError(w, err)
			return
		}
		status := 200
		if id == 0 {
			status = 201
		}
		writeJSON(w, status, u)
	}
	mux.HandleFunc("POST /api/v1/admin/users", a.administrator(save))
	mux.HandleFunc("PATCH /api/v1/admin/users/{id}", a.administrator(save))
	mux.HandleFunc("POST /api/v1/admin/users/{id}/password", a.administrator(func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil || id < 1 {
			writeError(w, 400, "invalid_request", "用户编号无效", nil)
			return
		}
		var body struct {
			Password string `json:"password"`
		}
		if !decodeJSON(w, r, 8192, &body) {
			return
		}
		if err = a.Auth.ResetUserPassword(id, body.Password); err != nil {
			userError(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/v1/auth/password", a.protect(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			OldPassword string `json:"oldPassword"`
			NewPassword string `json:"newPassword"`
		}
		if !decodeJSON(w, r, 8192, &body) {
			return
		}
		p, err := a.Auth.Authenticate(sessionToken(r))
		if err != nil {
			writeError(w, 401, "unauthenticated", "请重新登录", nil)
			return
		}
		if err = a.Auth.ChangePassword(p.ID, body.OldPassword, body.NewPassword); err != nil {
			userError(w, err)
			return
		}
		a.cookie(w, "", true)
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
}
