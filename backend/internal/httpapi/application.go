package httpapi

import (
	_ "embed"
	"net/http"
)

//go:embed openapi.json
var applicationSpecification []byte

//go:embed AGENT.md
var applicationAgentGuide []byte

func (a *api) registerApplication(mux *http.ServeMux) {
	// 仅包含接口结构及固定示例，不包含账号、目录、令牌或部署路径。
	mux.HandleFunc("GET /api/v1/openapi.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write(applicationSpecification)
	})
	mux.HandleFunc("GET /api/v1/agent.md", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		_, _ = w.Write(applicationAgentGuide)
	})
	mux.HandleFunc("GET /api/v1/application", a.protect(func(w http.ResponseWriter, r *http.Request) {
		p, token, err := authenticateRequest(a.Auth, r)
		if err != nil {
			writeError(w, 401, "unauthenticated", "访问令牌无效，请重新生成", nil)
			return
		}
		if token == nil {
			writeError(w, 403, "token_required", "此接口需要 Access Token，请使用 Authorization: Bearer 请求头", nil)
			return
		}
		writeJSON(w, 200, map[string]any{
			"apiVersion": "v1", "user": map[string]any{"id": p.ID, "username": p.Username},
			"workspaceId": a.WorkspaceID, "token": token,
		})
	}))
}
