package httpapi

import (
	"folio/internal/storage"
	"net/http"
	"strconv"
)

func (a *api) readContent(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	ranged := query.Has("startLine") || query.Has("lineCount")
	start, count := 1, 100
	for _, parameter := range []struct {
		name   string
		target *int
		max    int
	}{{"startLine", &start, 0}, {"lineCount", &count, storage.ReadLineLimit}} {
		if !query.Has(parameter.name) {
			continue
		}
		values := query[parameter.name]
		if len(values) != 1 {
			writeError(w, 400, "invalid_line_range", "行号参数不能重复", nil)
			return
		}
		value, err := strconv.Atoi(values[0])
		if err != nil || value < 1 || (parameter.max > 0 && value > parameter.max) {
			writeError(w, 400, "invalid_line_range", "startLine 须为正整数，lineCount 须为 1–1000；省略时分别为 1 和 100", nil)
			return
		}
		*parameter.target = value
	}
	expected := ""
	if values, present := r.Header["If-Match"]; present {
		if len(values) != 1 {
			writeError(w, 400, "invalid_request", "If-Match 必须为单个强 ETag", nil)
			return
		}
		var ok bool
		expected, ok = precondition(w, r)
		if !ok {
			return
		}
	}
	content, err := a.Workspace.Read(query.Get("path"))
	if err != nil {
		storageError(w, err)
		return
	}
	if expected != "" && content.Revision != expected {
		storageError(w, &storage.Error{Code: "revision_conflict", Revision: content.Revision})
		return
	}
	w.Header().Set("ETag", `"`+content.Revision+`"`)
	if !ranged {
		writeJSON(w, 200, content)
		return
	}
	selected, err := content.LineRange(start, count)
	if err != nil {
		storageError(w, err)
		return
	}
	writeJSON(w, 200, selected)
}
