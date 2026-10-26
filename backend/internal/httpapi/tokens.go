package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"folio/internal/auth"
)

// 显式路由白名单：新增接口不会自动获得令牌访问权。
type tokenAccess struct {
	Group string
	Write bool
}

var applicationRoutes = map[string]tokenAccess{
	"GET /application":         {"application", false},
	"GET /workspace/tree":      {"files", false},
	"GET /workspace/usage":     {"files", false},
	"GET /workspace/storage":   {"files", false},
	"GET /files/metadata":      {"files", false},
	"GET /files/revision":      {"files", false},
	"GET /files/content":       {"files", false},
	"GET /files/download":      {"files", false},
	"GET /files/preview":       {"files", false},
	"GET /entries/revision":    {"files", false},
	"GET /settings":            {"files", false},
	"POST /files":              {"files", true},
	"PUT /files/content":       {"files", true},
	"POST /directories":        {"files", true},
	"PATCH /entries/move":      {"files", true},
	"POST /uploads":            {"files", true},
	"GET /search":              {"search", false},
	"GET /search/status":       {"search", false},
	"GET /search/file-status":  {"search", false},
	"POST /search/rebuild":     {"search", true},
	"GET /trash":               {"trash", false},
	"DELETE /entries":          {"trash", true},
	"POST /trash/{id}/restore": {"trash", true},
}

func tokenPermission(r *http.Request) (string, bool) {
	if !strings.HasPrefix(r.URL.Path, "/api/v1/") {
		return "", false
	}
	route := strings.TrimPrefix(r.URL.Path, "/api/v1")
	parts := strings.Split(route, "/")
	if len(parts) == 4 && parts[1] == "trash" && parts[2] != "" && parts[3] == "restore" {
		route = "/trash/{id}/restore"
	}
	method := r.Method
	if method == http.MethodHead {
		method = http.MethodGet
	}
	access := applicationRoutes[method+" "+route]
	return access.Group, access.Write
}
func authorizeToken(t *auth.AccessToken, r *http.Request) bool {
	group, write := tokenPermission(r)
	if group == "application" {
		return true
	}
	permission := ""
	switch group {
	case "files":
		permission = t.Permissions.Files
	case "search":
		permission = t.Permissions.Search
	case "trash":
		permission = t.Permissions.Trash
	}
	if permission != "read" && permission != "write" {
		return false
	}
	if write && permission != "write" {
		return false
	}
	if write && group == "trash" && t.Permissions.Files != "write" {
		return false
	}
	return true
}
func authenticateRequest(s *auth.Service, r *http.Request) (*auth.Principal, *auth.AccessToken, error) {
	if _, present := r.Header["Authorization"]; present {
		values := r.Header.Values("Authorization")
		if len(values) != 1 {
			return nil, nil, auth.ErrCredentials
		}
		parts := strings.Fields(values[0])
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			return nil, nil, auth.ErrCredentials
		}
		return s.AuthenticateAccessToken(parts[1])
	}
	p, err := s.Authenticate(sessionToken(r))
	return p, nil, err
}
func tokenError(w http.ResponseWriter, err error) {
	if errors.Is(err, auth.ErrTokenInput) {
		writeError(w, 400, "invalid_token", err.Error(), nil)
	} else if errors.Is(err, auth.ErrTokenLimit) {
		writeError(w, 409, "token_limit", err.Error(), nil)
	} else {
		userError(w, err)
	}
}
func (a *api) registerTokens(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/user/tokens", a.protect(func(w http.ResponseWriter, r *http.Request) {
		p, err := a.Auth.Authenticate(sessionToken(r))
		if err != nil {
			userError(w, err)
			return
		}
		entries, err := a.Auth.AccessTokens(p.ID)
		if err != nil {
			tokenError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"entries": entries})
	}))
	mux.HandleFunc("POST /api/v1/user/tokens", a.protect(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name        string                `json:"name"`
			ExpiresAt   int64                 `json:"expiresAt"`
			Permissions auth.TokenPermissions `json:"permissions"`
		}
		if !decodeJSON(w, r, 4096, &body) {
			return
		}
		p, err := a.Auth.Authenticate(sessionToken(r))
		if err != nil {
			userError(w, err)
			return
		}
		token, secret, err := a.Auth.CreateAccessToken(p.ID, a.WorkspaceID, body.Name, body.ExpiresAt, body.Permissions)
		if err != nil {
			tokenError(w, err)
			return
		}
		writeJSON(w, 201, struct {
			auth.AccessToken
			Token string `json:"token"`
		}{token, secret})
	}))
	mux.HandleFunc("DELETE /api/v1/user/tokens/{id}", a.protect(func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil || id < 1 {
			writeError(w, 400, "invalid_request", "令牌编号无效", nil)
			return
		}
		p, err := a.Auth.Authenticate(sessionToken(r))
		if err != nil {
			userError(w, err)
			return
		}
		if err = a.Auth.DeleteAccessToken(p.ID, id); err != nil {
			tokenError(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
}
