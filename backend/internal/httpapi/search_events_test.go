package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"folio/internal/auth"
	"folio/internal/search"
	"folio/internal/storage"
	"folio/internal/trash"
)

func TestFileAPIsUpdateOnlyAffectedSearchPaths(t *testing.T) {
	root, data := t.TempDir(), t.TempDir()
	store, err := storage.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	recycle, err := trash.Open(filepath.Join(data, "trash"))
	if err != nil {
		t.Fatal(err)
	}
	defer recycle.Close()
	store.SetTrash(recycle)
	accounts, err := auth.Open(data, "search-events-password-123")
	if err != nil {
		t.Fatal(err)
	}
	defer accounts.Close()
	index, err := search.Open(data, store, 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer index.Close()
	token, principal, err := accounts.Login("admin", "search-events-password-123", "", "local")
	if err != nil {
		t.Fatal(err)
	}
	handler := New(fstest.MapFS{}, Options{Auth: accounts, Workspace: store, Search: index})
	call := func(method, endpoint string, body any, etag string) *httptest.ResponseRecorder {
		t.Helper()
		var encoded []byte
		if body != nil {
			encoded, _ = json.Marshal(body)
		}
		request := httptest.NewRequest(method, "/api/v1"+endpoint, bytes.NewReader(encoded))
		request.AddCookie(&http.Cookie{Name: cookieName, Value: token})
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-CSRF-Token", principal.CSRF)
		if etag != "" {
			request.Header.Set("If-Match", etag)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	check := func(response *httptest.ResponseRecorder, expected int) {
		t.Helper()
		if response.Code != expected {
			t.Fatalf("状态 %d，预期 %d：%s", response.Code, expected, response.Body.String())
		}
	}
	wait := func(query, mode string, count int) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			result, err := index.Query(context.Background(), query, mode, 50)
			if err == nil && len(result.Entries) == count && !index.Status().Indexing && index.Status().Warning == "" {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("索引未收敛：%s %+v", query, index.Status())
	}
	wait("", "names", 0)
	if err := os.WriteFile(filepath.Join(root, "external.txt"), []byte("external_unnotified_token"), 0600); err != nil {
		t.Fatal(err)
	}
	check(call("POST", "/directories", map[string]string{"path": "folder"}, ""), 201)
	created := call("POST", "/files", map[string]string{"path": "folder/note.txt", "content": "created_token"}, "")
	check(created, 201)
	wait("created_token", "", 1)
	saved := call("PUT", "/files/content?path=folder/note.txt", map[string]string{"content": "saved_token"}, created.Header().Get("ETag"))
	check(saved, 200)
	wait("saved_token", "", 1)
	wait("created_token", "", 0)
	check(call("PATCH", "/entries/move", map[string]string{"from": "folder/note.txt", "to": "folder/renamed.log"}, saved.Header().Get("ETag")), 200)
	wait("folder/note.txt", "names", 0)
	wait("folder/renamed.log", "names", 1)
	revision := call("GET", "/entries/revision?path=folder", nil, "")
	check(revision, 200)
	check(call("PATCH", "/entries/move", map[string]string{"from": "folder", "to": "moved"}, revision.Header().Get("ETag")), 200)
	wait("folder/", "names", 0)
	wait("moved/renamed.log", "names", 1)
	revision = call("GET", "/entries/revision?path=moved", nil, "")
	check(revision, 200)
	removed := call("DELETE", "/entries?path=moved", nil, revision.Header().Get("ETag"))
	check(removed, 200)
	wait("saved_token", "", 0)
	var record trash.Record
	if err := json.Unmarshal(removed.Body.Bytes(), &record); err != nil {
		t.Fatal(err)
	}
	check(call("POST", "/trash/"+record.ID+"/restore", nil, ""), 200)
	wait("saved_token", "", 1)
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "uploaded.yaml")
	if err != nil {
		t.Fatal(err)
	}
	part.Write([]byte("uploaded_body_token"))
	writer.Close()
	request := httptest.NewRequest("POST", "/api/v1/uploads?directory=moved", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("X-CSRF-Token", principal.CSRF)
	request.AddCookie(&http.Cookie{Name: cookieName, Value: token})
	uploaded := httptest.NewRecorder()
	handler.ServeHTTP(uploaded, request)
	check(uploaded, 201)
	wait("uploaded_body_token", "", 1)
	wait("external_unnotified_token", "", 0)
	before := index.Status().IndexedAt
	check(call("POST", "/files", map[string]string{"path": "moved/renamed.log", "content": "must_not_replace"}, ""), 409)
	check(call("POST", "/directories", map[string]string{"path": "empty"}, ""), 201)
	check(call("POST", "/auth/password", map[string]string{}, ""), 400)
	time.Sleep(100 * time.Millisecond)
	if index.Status().IndexedAt != before {
		t.Fatal("失败写入、空目录或账号设置不应触发索引")
	}
	// 不确定的磁盘操作结果仍需核对；恢复目标未知时执行一次全量补偿。
	a := &api{Options: Options{Search: index}}
	a.indexChange(&storage.Error{Code: "durability_uncertain"}, "external.txt")
	wait("external_unnotified_token", "", 1)
	if err := os.WriteFile(filepath.Join(root, "uncertain.txt"), []byte("uncertain_restore_token"), 0600); err != nil {
		t.Fatal(err)
	}
	a.indexChange(&storage.Error{Code: "trash_incomplete"})
	wait("uncertain_restore_token", "", 1)
	fileStatus := call("GET", "/search/file-status?path=moved/uploaded.yaml", nil, "")
	check(fileStatus, 200)
	var details search.FileStatus
	if err := json.Unmarshal(fileStatus.Body.Bytes(), &details); err != nil || details.State != "indexed" || details.Size != int64(len("uploaded_body_token")) {
		t.Fatalf("状态接口不符：%s", fileStatus.Body.String())
	}
	check(call("GET", "/search/file-status?path=../outside", nil, ""), 400)
	anonymous := httptest.NewRecorder()
	handler.ServeHTTP(anonymous, httptest.NewRequest("GET", "/api/v1/search/file-status?path=moved/uploaded.yaml", nil))
	check(anonymous, 401)

	result := call("GET", "/search?q=uploaded_body_token", nil, "")
	check(result, 200)
	if !strings.Contains(result.Body.String(), "moved/uploaded.yaml") {
		t.Fatal("搜索接口未返回上传正文")
	}
}
