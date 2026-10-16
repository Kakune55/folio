package httpapi

import (
	"net/http"
	"strconv"
	"strings"
)

func precondition(w http.ResponseWriter, r *http.Request) (string, bool) {
	revision := r.Header.Get("If-Match")
	if revision == "" {
		writeError(w, 428, "precondition_required", "操作必须携带读取时的版本", nil)
		return "", false
	}
	if len(revision) != len(`"sha256:`)+64+1 || !strings.HasPrefix(revision, `"sha256:`) || !strings.HasSuffix(revision, `"`) {
		writeError(w, 400, "invalid_request", "需要单个完整的强 ETag", nil)
		return "", false
	}
	return strings.Trim(revision, `"`), true
}
func pagination(w http.ResponseWriter, r *http.Request) (int, int, bool) {
	offset, limit := 0, 200
	var err error
	if raw := r.URL.Query().Get("offset"); raw != "" {
		offset, err = strconv.Atoi(raw)
		if err != nil || offset < 0 {
			writeError(w, 400, "invalid_request", "分页参数不正确", nil)
			return 0, 0, false
		}
	}
	if raw := r.URL.Query().Get("limit"); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 1000 {
			writeError(w, 400, "invalid_request", "每页条数须为 1 到 1000", nil)
			return 0, 0, false
		}
	}
	return offset, limit, true
}
func (a *api) registerEntries(mux *http.ServeMux) {
	mux.HandleFunc("DELETE /api/v1/trash/{id}", a.protect(func(w http.ResponseWriter, r *http.Request) {
		if err := a.Workspace.Purge(r.PathValue("id")); err != nil {
			storageError(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("GET /api/v1/workspace/usage", a.protect(func(w http.ResponseWriter, r *http.Request) {
		usage, err := a.Workspace.Usage()
		if err != nil {
			storageError(w, err)
			return
		}
		writeJSON(w, 200, usage)
	}))

	mux.HandleFunc("GET /api/v1/entries/revision", a.protect(func(w http.ResponseWriter, r *http.Request) {
		revision, err := a.Workspace.EntryRevision(r.URL.Query().Get("path"))
		if err != nil {
			storageError(w, err)
			return
		}
		w.Header().Set("ETag", `"`+revision.Revision+`"`)
		writeJSON(w, 200, revision)
	}))
	mux.HandleFunc("PATCH /api/v1/entries/move", a.protect(func(w http.ResponseWriter, r *http.Request) {
		revision, ok := precondition(w, r)
		if !ok {
			return
		}
		var body struct {
			From string `json:"from"`
			To   string `json:"to"`
		}
		if !decodeJSON(w, r, 16384, &body) {
			return
		}
		err := a.Workspace.Move(body.From, body.To, revision)
		a.indexChange(err, body.From, body.To)
		if err != nil {
			storageError(w, err)
			return
		}
		writeJSON(w, 200, map[string]string{"from": body.From, "to": body.To})
	}))
	mux.HandleFunc("DELETE /api/v1/entries", a.protect(func(w http.ResponseWriter, r *http.Request) {
		revision, ok := precondition(w, r)
		if !ok {
			return
		}
		record, err := a.Workspace.Trash(r.URL.Query().Get("path"), revision)
		a.indexChange(err, r.URL.Query().Get("path"))
		if err != nil {
			storageError(w, err)
			return
		}
		writeJSON(w, 200, record)
	}))
	mux.HandleFunc("GET /api/v1/trash", a.protect(func(w http.ResponseWriter, r *http.Request) {
		offset, limit, ok := pagination(w, r)
		if !ok {
			return
		}
		records, total, err := a.Workspace.TrashList(offset, limit)
		if err != nil {
			storageError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"entries": records, "total": total, "offset": offset, "limit": limit})
	}))
	mux.HandleFunc("POST /api/v1/trash/{id}/restore", a.protect(func(w http.ResponseWriter, r *http.Request) {
		path, err := a.Workspace.Restore(r.PathValue("id"))
		if err == nil {
			a.indexChange(nil, path)
		} else {
			a.indexChange(err)
		}
		if err != nil {
			storageError(w, err)
			return
		}
		writeJSON(w, 200, map[string]string{"path": path})
	}))
}
