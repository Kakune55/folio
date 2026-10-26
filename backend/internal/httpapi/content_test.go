package httpapi

import (
	"encoding/json"
	"folio/internal/auth"
	"folio/internal/storage"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"testing/fstest"
)

func TestLineReadParametersCompatibilityAndVersion(t *testing.T) {
	store, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	accounts, err := auth.Open(t.TempDir(), "line-reading-password-2026")
	if err != nil {
		t.Fatal(err)
	}
	defer accounts.Close()
	session, _, err := accounts.Login("admin", "line-reading-password-2026", "", "local")
	if err != nil {
		t.Fatal(err)
	}
	revision, err := store.Write("note.txt", "a\r\nb\nc", "", true)
	if err != nil {
		t.Fatal(err)
	}
	handler := New(fstest.MapFS{}, Options{Auth: accounts, Workspace: store})
	call := func(query, etag string, want int) map[string]any {
		t.Helper()
		r := httptest.NewRequest("GET", "/api/v1/files/content?path=note.txt"+query, nil)
		r.AddCookie(&http.Cookie{Name: cookieName, Value: session})
		if etag != "" {
			r.Header.Set("If-Match", etag)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("want %d got %d %s", want, w.Code, w.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if want == 200 && w.Header().Get("ETag") != `"`+revision+`"` {
			t.Fatal("不是完整正文版本")
		}
		return body
	}
	full := call("", "", 200)
	if _, exists := full["lineCount"]; exists || full["content"] != "a\r\nb\nc" {
		t.Fatal("全文响应兼容性变化", full)
	}
	first := call("&lineCount=1", "", 200)
	if first["content"] != "a\r\n" || first["totalLines"] != float64(3) || first["nextLine"] != float64(2) {
		t.Fatal(first)
	}
	second := call("&startLine=2", `"`+revision+`"`, 200)
	if second["content"] != "b\nc" || second["requestedLineCount"] != float64(100) || second["lineCount"] != float64(2) || second["isPartial"] != true {
		t.Fatal(second)
	}
	call("", `"`+revision+`"`, 200)
	for _, query := range []string{"&startLine=0", "&startLine=-1", "&startLine=", "&lineCount=0", "&lineCount=1001", "&lineCount=", "&lineCount=x", "&startLine=1&startLine=2", "&lineCount=1&lineCount=1", "&startLine=999999999999999999999999"} {
		call(query, "", 400)
	}
	call("&lineCount=1", "*", 400)
	call("&startLine="+strconv.Itoa(int(^uint(0)>>1)), "", 200)
	if _, err = store.Write("note.txt", "changed\n", revision, false); err != nil {
		t.Fatal(err)
	}
	call("&startLine=2&lineCount=1", `"`+revision+`"`, 412)
	call("", `"`+revision+`"`, 412)
	limits := store.Limits()
	limits.Text = 1
	if err = store.SetLimits(limits); err != nil {
		t.Fatal(err)
	}
	call("&lineCount=1", "", 413)
}
