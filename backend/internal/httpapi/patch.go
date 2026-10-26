package httpapi

import (
	"folio/internal/storage"
	"net/http"
	"time"
)

func (a *api) registerPatch(mux *http.ServeMux) {
	mux.HandleFunc("PATCH /api/v1/files/content", a.protect(func(w http.ResponseWriter, r *http.Request) {
		revision, ok := precondition(w, r)
		if !ok {
			return
		}
		var body struct {
			Diff   string `json:"diff"`
			DryRun bool   `json:"dryRun"`
		}
		if !decodeJSON(w, r, storage.PatchByteLimit*6+16384, &body) {
			return
		}
		name := r.URL.Query().Get("path")
		result, err := a.Workspace.Patch(name, body.Diff, revision, body.DryRun)
		if !body.DryRun && (err != nil || result.Changed) {
			a.indexChange(err, name)
		}
		if err != nil {
			storageError(w, err)
			return
		}
		w.Header().Set("ETag", `"`+result.Revision+`"`)
		savedAt := ""
		if !body.DryRun && result.Changed {
			savedAt = time.Now().UTC().Format(time.RFC3339Nano)
		}
		writeJSON(w, 200, struct {
			*storage.PatchResult
			SavedAt string `json:"savedAt,omitempty"`
		}{result, savedAt})
	}))
}
