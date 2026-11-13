package httpapi

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"folio/internal/auth"
)

func TestMCPExtendedToolsPreserveLegacyParameters(t *testing.T) {
	e := newMCPTestEnv(t, "")
	_, secret := e.token(1, auth.TokenPermissions{Files: "write", Search: "read", Trash: "write"})
	response := e.rpc(secret, "tools/list", map[string]any{})
	var result struct {
		Tools []struct {
			Name        string
			InputSchema struct {
				Properties map[string]any
				Required   []string
			}
		}
	}
	if err := json.Unmarshal(response.Result, &result); err != nil {
		t.Fatal(err)
	}
	want := map[string][2]string{
		"listDirectory":    {"limit,offset,path", ""},
		"readContent":      {"expectedRevision,lineCount,path,startLine", "path"},
		"createFile":       {"content,path", "content,path"},
		"createDirectory":  {"path", "path"},
		"patchContent":     {"diff,dryRun,expectedRevision,path", "diff,expectedRevision,path"},
		"getEntryRevision": {"path", "path"},
		"moveEntry":        {"expectedRevision,from,to", "expectedRevision,from,to"},
		"trashEntry":       {"expectedRevision,path", "expectedRevision,path"},
		"listTrash":        {"limit,offset", ""},
		"restoreEntry":     {"id", "id"},
		"searchFiles":      {"limit,mode,query", "query"},
		"updateContent":    {"content,expectedRevision,path", "content,expectedRevision,path"},
		"downloadFile":     {"delivery,path", "path"},
		"uploadFile":       {"contentBase64,expectedRevision,mode,path", "contentBase64,path"},
	}
	if len(result.Tools) != len(want) {
		t.Fatal("工具总量错误", len(result.Tools))
	}
	for _, tool := range result.Tools {
		fields := make([]string, 0, len(tool.InputSchema.Properties))
		for name := range tool.InputSchema.Properties {
			fields = append(fields, name)
		}
		sort.Strings(fields)
		sort.Strings(tool.InputSchema.Required)
		if expected, exists := want[tool.Name]; !exists || strings.Join(fields, ",") != expected[0] || strings.Join(tool.InputSchema.Required, ",") != expected[1] {
			t.Fatalf("参数发生非预期变更：%+v", tool)
		}
	}
}

func TestMCPUpdateContentCompleteReadGuard(t *testing.T) {
	e := newMCPTestEnv(t, "")
	permissions := auth.TokenPermissions{Files: "write", Search: "none", Trash: "none"}
	_, secret := e.token(1, permissions)
	_, another := e.token(1, permissions)
	user, err := e.accounts.SaveUser(0, auth.UserInput{Username: "reader", Enabled: true, Quota: 1 << 20, Password: "mcp-reader-password-2026"})
	if err != nil {
		t.Fatal(err)
	}
	_, otherUser := e.token(user.ID, permissions)
	source := "\ufeff" + strings.Repeat("原文\r\n", 1002) + "尾行\r"
	var created struct{ Revision string }
	e.success(secret, "createFile", map[string]any{"path": "note.md", "content": source}, &created)
	e.success(otherUser, "createFile", map[string]any{"path": "note.md", "content": source}, nil)
	candidate := "\ufeff重写首行\n" + strings.Repeat("原文\r\n", 1002) + "尾行\r"
	args := map[string]any{"path": "note.md", "content": candidate, "expectedRevision": created.Revision}
	e.failure(secret, "updateContent", args, "full_read_required", false)
	e.success(secret, "getEntryRevision", map[string]any{"path": "note.md"}, nil)
	e.failure(secret, "updateContent", args, "full_read_required", false)
	e.success(secret, "readContent", map[string]any{"path": "note.md"}, nil)
	e.failure(secret, "updateContent", args, "full_read_required", false)
	// 分段必须覆盖所有行，不能以读到末尾或越界代替读完。
	e.success(secret, "readContent", map[string]any{"path": "note.md", "startLine": 1003, "expectedRevision": created.Revision}, nil)
	e.success(secret, "readContent", map[string]any{"path": "note.md", "startLine": 2000, "expectedRevision": created.Revision}, nil)
	e.failure(secret, "updateContent", args, "full_read_required", false)
	e.success(secret, "readContent", map[string]any{"path": "note.md", "startLine": 101, "lineCount": 902, "expectedRevision": created.Revision}, nil)
	e.failure(another, "updateContent", args, "full_read_required", false)
	e.failure(otherUser, "updateContent", args, "full_read_required", false)
	var updated struct{ Revision string }
	e.success(secret, "updateContent", args, &updated)
	if updated.Revision == "" || updated.Revision == created.Revision {
		t.Fatal("整篇替换未返回新版本")
	}
	e.failure(secret, "updateContent", args, "revision_conflict", false)
	args["expectedRevision"] = updated.Revision
	e.failure(secret, "updateContent", args, "full_read_required", false)
	entry, err := e.handler.get(1)
	if err != nil {
		t.Fatal(err)
	}
	actual, err := entry.store.Read("note.md")
	if err != nil || actual.Content != candidate || actual.Revision != updated.Revision {
		t.Fatalf("全文字节丢失：%+v %v", actual, err)
	}
	// base64 replace 同样不能绕过可编辑文本读取保护。
	upload := map[string]any{"path": "note.md", "mode": "replace", "expectedRevision": updated.Revision, "contentBase64": base64.StdEncoding.EncodeToString([]byte("fragment"))}
	e.failure(secret, "uploadFile", upload, "full_read_required", false)
	var huge struct{ Revision string }
	e.success(secret, "createFile", map[string]any{"path": "huge-line.md", "content": strings.Repeat("x", mcpReadByteLimit+1)}, &huge)
	e.failure(secret, "readContent", map[string]any{"path": "huge-line.md"}, "too_large", false)
	e.failure(secret, "updateContent", map[string]any{"path": "huge-line.md", "content": "fragment", "expectedRevision": huge.Revision}, "full_read_required", false)
	var disguised struct{ Revision string }
	e.success(secret, "createFile", map[string]any{"path": "pdf-prefix.md", "content": "%PDF-\n# original note\nimportant body\n"}, &disguised)
	args = map[string]any{"path": "pdf-prefix.md", "mode": "replace", "contentBase64": base64.StdEncoding.EncodeToString([]byte("fragment")), "expectedRevision": disguised.Revision}
	e.failure(secret, "updateContent", map[string]any{"path": "pdf-prefix.md", "content": "fragment", "expectedRevision": disguised.Revision}, "full_read_required", false)
	e.failure(secret, "uploadFile", args, "full_read_required", false)
	actual, err = entry.store.Read("pdf-prefix.md")
	if err != nil || actual.Content != "%PDF-\n# original note\nimportant body\n" {
		t.Fatalf("预览误分类导致正文丢失：%+v %v", actual, err)
	}
	e.success(secret, "readContent", map[string]any{"path": "pdf-prefix.md"}, nil)
	e.success(secret, "uploadFile", args, nil)
}

func TestMCPAttachmentInlineAndSingleUseURL(t *testing.T) {
	e := newMCPTestEnv(t, "http://localhost")
	_, secret := e.token(1, auth.TokenPermissions{Files: "write", Search: "none", Trash: "none"})
	var imageBytes bytes.Buffer
	if err := png.Encode(&imageBytes, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path string
		data []byte
		kind string
	}{
		{"pixel.png", imageBytes.Bytes(), "image"},
		{"binary.bin", []byte{0xff, 0, 1, 2, 3}, "resource"},
		{"empty.bin", []byte{}, "resource"},
	} {
		encoded := base64.StdEncoding.EncodeToString(tc.data)
		var uploaded struct{ Revision string }
		e.success(secret, "uploadFile", map[string]any{"path": tc.path, "contentBase64": encoded}, &uploaded)
		e.failure(secret, "uploadFile", map[string]any{"path": tc.path, "contentBase64": encoded}, "target_exists", false)
		response := e.rpc(secret, "tools/call", map[string]any{"name": "downloadFile", "arguments": map[string]any{"path": tc.path}})
		var result struct {
			IsError           bool
			StructuredContent struct {
				Revision, Delivery string
				Size               int
			}
			Content []struct {
				Type, Text string
				Data       []byte
				Resource   *struct {
					Blob []byte
					URI  string
				}
			}
		}
		if err := json.Unmarshal(response.Result, &result); err != nil {
			t.Fatal(err)
		}
		if response.Error != nil || result.IsError || result.StructuredContent.Revision != uploaded.Revision || result.StructuredContent.Delivery != "inline" || result.StructuredContent.Size != len(tc.data) || len(result.Content) != 2 || result.Content[1].Type != tc.kind {
			t.Fatalf("内联结果错误：%s", response.Result)
		}
		got := result.Content[1].Data
		if tc.kind == "resource" {
			if result.Content[1].Resource == nil {
				t.Fatal("内嵌资源缺失")
			}
			got = result.Content[1].Resource.Blob
		}
		if !bytes.Equal(got, tc.data) {
			t.Fatalf("附件字节不一致：%x %x", got, tc.data)
		}
		if len(tc.data) == 0 && !bytes.Contains(response.Result, []byte(`"blob":""`)) {
			t.Fatal("空附件未返回合法的空blob")
		}
		if len(tc.data) > 0 && strings.Contains(result.Content[0].Text, encoded) {
			t.Fatal("文本中重复返回附件base64")
		}
		var ticket struct{ URL, Revision string }
		e.success(secret, "downloadFile", map[string]any{"path": tc.path, "delivery": "url"}, &ticket)
		if ticket.Revision != uploaded.Revision || !strings.HasPrefix(ticket.URL, "http://localhost/api/v1/public/mcp-download/") || strings.Contains(ticket.URL, secret) {
			t.Fatalf("URL错误：%+v", ticket)
		}
		request := httptest.NewRequest("GET", ticket.URL, nil)
		w := httptest.NewRecorder()
		e.handler.ServeHTTP(w, request)
		if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), tc.data) || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("单次下载错误：%d %q", w.Code, w.Body.Bytes())
		}
		w = httptest.NewRecorder()
		e.handler.ServeHTTP(w, httptest.NewRequest("GET", ticket.URL, nil))
		if w.Code == 200 {
			t.Fatal("票据可重复使用")
		}
	}
	var revision struct{ Revision string }
	e.success(secret, "getEntryRevision", map[string]any{"path": "binary.bin"}, &revision)
	replacement := []byte{0, 4, 5, 6}
	args := map[string]any{"path": "binary.bin", "contentBase64": base64.StdEncoding.EncodeToString(replacement), "mode": "replace", "expectedRevision": revision.Revision}
	e.success(secret, "uploadFile", args, nil)
	response := e.rpc(secret, "tools/call", map[string]any{"name": "downloadFile", "arguments": map[string]any{"path": "binary.bin"}})
	var downloaded struct {
		Content []struct{ Resource *struct{ Blob []byte } }
	}
	if err := json.Unmarshal(response.Result, &downloaded); err != nil {
		t.Fatal(err)
	}
	if len(downloaded.Content) != 2 || downloaded.Content[1].Resource == nil || !bytes.Equal(downloaded.Content[1].Resource.Blob, replacement) {
		t.Fatalf("替换后的下载字节错误：%s", response.Result)
	}
	e.failure(secret, "uploadFile", args, "revision_conflict", false)
	e.failure(secret, "uploadFile", map[string]any{"path": "binary.bin", "contentBase64": "AA==", "mode": "replace"}, "precondition_required", false)
	for _, bad := range []string{"!", "AB==", "AA==\n", "data:image/png;base64,AA=="} {
		e.failure(secret, "uploadFile", map[string]any{"path": "bad.bin", "contentBase64": bad}, "invalid_request", false)
	}
	e.failure(secret, "uploadFile", map[string]any{"path": "large.bin", "contentBase64": base64.StdEncoding.EncodeToString(make([]byte, mcpAttachmentByteLimit+1))}, "too_large", false)
	entry, err := e.handler.get(1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = entry.store.Upload("", "large-existing.bin", bytes.NewReader(make([]byte, mcpAttachmentByteLimit+1)), false); err != nil {
		t.Fatal(err)
	}
	e.failure(secret, "downloadFile", map[string]any{"path": "large-existing.bin"}, "too_large", false)
}
