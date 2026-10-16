package httpapi

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"folio/internal/auth"
	"folio/internal/storage"
)

func TestAttachmentBoundary(t *testing.T) {
	root := t.TempDir()
	store, err := storage.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	appData := filepath.Join(t.TempDir(), "app-data")
	if err = os.Mkdir(appData, 0o700); err != nil {
		t.Fatal(err)
	}
	accounts, err := auth.Open(appData, "附件测试密码-123456")
	if err != nil {
		t.Fatal(err)
	}
	defer accounts.Close()
	handler := New(fstest.MapFS{}, Options{Auth: accounts, Workspace: store})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/v1/files/preview?path=a.png", nil))
	if response.Code != 401 {
		t.Fatal("预览未认证")
	}
	token, principal, err := accounts.Login("admin", "附件测试密码-123456", "", "local")
	if err != nil {
		t.Fatal(err)
	}
	upload := func(name string, data []byte, extra bool, imageOnly bool) *httptest.ResponseRecorder {
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		part, err := writer.CreateFormFile("file", name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = part.Write(data)
		if extra {
			part, _ = writer.CreateFormFile("file", "extra.txt")
			_, _ = part.Write([]byte("不允许"))
		}
		_ = writer.Close()
		endpoint := "/api/v1/uploads?directory="
		if imageOnly {
			endpoint += "&image=true"
		}
		r := httptest.NewRequest("POST", endpoint, &body)
		r.Header.Set("Content-Type", writer.FormDataContentType())
		r.Header.Set("X-CSRF-Token", principal.CSRF)
		r.AddCookie(&http.Cookie{Name: cookieName, Value: token})
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	var imageData bytes.Buffer
	picture := image.NewRGBA(image.Rect(0, 0, 2, 2))
	picture.Set(0, 0, color.RGBA{R: 100, G: 150, B: 200, A: 255})
	if err = png.Encode(&imageData, picture); err != nil {
		t.Fatal(err)
	}
	first := upload("中文.png", imageData.Bytes(), false, true)
	if first.Code != 201 {
		t.Fatalf("上传失败：%d %s", first.Code, first.Body.String())
	}
	var metadata storage.Metadata
	_ = json.Unmarshal(first.Body.Bytes(), &metadata)
	if metadata.Viewer != "image" || metadata.Path != "中文.png" {
		t.Fatalf("图片识别错误：%+v", metadata)
	}
	duplicate := upload("中文.png", []byte("不得覆盖"), false, false)
	if duplicate.Code != 409 {
		t.Fatalf("重复覆盖：%d", duplicate.Code)
	}
	for _, test := range []struct {
		name             string
		data             []byte
		extra, imageOnly bool
		status           int
	}{
		{"../escape.txt", []byte("路径穿越"), false, false, 400},
		{"multiple.txt", []byte("第一个文件"), true, false, 400},
		{"script.svg", []byte(`<svg onload="alert(1)"></svg>`), false, true, 415},
	} {
		w := upload(test.name, test.data, test.extra, test.imageOnly)
		if w.Code != test.status {
			t.Fatalf("%s：%d %s", test.name, w.Code, w.Body.String())
		}
	}
	if _, err = os.Stat(filepath.Join(root, "multiple.txt")); !os.IsNotExist(err) {
		t.Fatal("多文件畸形请求部分提交")
	}
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>`)
	if w := upload("源码.svg", svg, false, false); w.Code != 201 {
		t.Fatalf("SVG 附件不能保存：%s", w.Body.String())
	}
	get := func(url string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", url, nil)
		r.AddCookie(&http.Cookie{Name: cookieName, Value: token})
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	imagePreview := get("/api/v1/files/preview?path=中文.png")
	if imagePreview.Code != 200 || imagePreview.Header().Get("Content-Type") != "image/png" || !bytes.Equal(imagePreview.Body.Bytes(), imageData.Bytes()) {
		t.Fatal("图片预览响应错误")
	}
	if get("/api/v1/files/preview?path=源码.svg").Code != 415 {
		t.Fatal("SVG 被作为活动内容预览")
	}
	download := get("/api/v1/files/download?path=源码.svg")
	if download.Header().Get("Content-Type") != "application/octet-stream" || !strings.HasPrefix(download.Header().Get("Content-Disposition"), "attachment") || !strings.Contains(download.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Fatal("下载未隔离")
	}
	limits := storage.DefaultLimits
	limits.Image = 16
	if err = store.SetLimits(limits); err != nil {
		t.Fatal(err)
	}
	oversized := upload("too-big.png", imageData.Bytes(), false, false)
	if oversized.Code != 413 {
		t.Fatalf("流式大小限制失效：%d", oversized.Code)
	}
	if _, err = os.Stat(filepath.Join(root, "too-big.png")); !os.IsNotExist(err) {
		t.Fatal("超限上传留下目标文件")
	}
}
