package storage

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func attachmentPNG(t *testing.T, width int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, width, 2))
	img.Set(0, 0, color.NRGBA{R: 255, A: 255})
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func attachmentBytes(t *testing.T, root, name string, expected []byte) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, name))
	if err != nil || !bytes.Equal(data, expected) {
		t.Fatalf("附件原始字节不符：%x %v", data, err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".folio-tmp-") {
			t.Fatal("操作结束后遗留临时文件")
		}
	}
}

func TestAttachmentUploadConditionalBytes(t *testing.T) {
	for _, imageOnly := range []bool{false, true} {
		t.Run(map[bool]string{false: "binary", true: "image"}[imageOnly], func(t *testing.T) {
			store, root := testStore(t)
			old, next := []byte{0, 255, 128, 13, 10}, []byte{254, 0, 1, 2}
			if imageOnly {
				old, next = attachmentPNG(t, 2), attachmentPNG(t, 3)
			}
			metadata, revision, err := store.UploadConditional("", "file.bin", bytes.NewReader(old), imageOnly, "", true)
			if err != nil || revision != digest(old) || metadata.Size != int64(len(old)) {
				t.Fatalf("创建失败：%+v %s %v", metadata, revision, err)
			}
			if imageOnly && metadata.Viewer != "image" {
				t.Fatal("真实 PNG 未识别")
			}
			attachmentBytes(t, root, "file.bin", old)
			if err := os.Chmod(filepath.Join(root, "file.bin"), 0o640); err != nil {
				t.Fatal(err)
			}
			_, err = store.Upload("", "file.bin", bytes.NewReader(next), imageOnly)
			code(t, err, "target_exists")
			_, _, err = store.UploadConditional("", "file.bin", bytes.NewReader(next), imageOnly, "", false)
			code(t, err, "precondition_required")
			_, _, err = store.UploadConditional("", "file.bin", bytes.NewReader(next), imageOnly, "stale", false)
			code(t, err, "revision_conflict")
			var problem *Error
			if !errors.As(err, &problem) || problem.Revision != revision {
				t.Fatal("冲突未携带当前版本", err)
			}
			attachmentBytes(t, root, "file.bin", old)
			_, got, err := store.UploadConditional("", "file.bin", bytes.NewReader(next), imageOnly, revision, false)
			if err != nil || got != digest(next) {
				t.Fatal(got, err)
			}
			attachmentBytes(t, root, "file.bin", next)
			info, err := os.Stat(filepath.Join(root, "file.bin"))
			if err != nil || info.Mode().Perm() != 0o640 {
				t.Fatal("替换未保留权限", err)
			}
		})
	}
}

type attachmentErrorReader struct{ err error }

func (r attachmentErrorReader) Read([]byte) (int, error) { return 0, r.err }

func TestAttachmentUploadFailurePreservesOld(t *testing.T) {
	store, root := testStore(t)
	old := []byte{0, 255, 1, 2}
	_, revision, err := store.UploadConditional("", "file.bin", bytes.NewReader(old), false, "", true)
	if err != nil {
		t.Fatal(err)
	}
	limits := Limits{Text: 32, Image: 64, PDF: 64, Attachment: 8192, ImagePixels: 2}
	if err := store.SetLimits(limits); err != nil {
		t.Fatal(err)
	}
	broken := errors.New("上传流中断")
	for _, tc := range []struct {
		name      string
		reader    io.Reader
		imageOnly bool
		code      string
	}{
		{"reader", io.MultiReader(strings.NewReader(strings.Repeat("x", 5000)), attachmentErrorReader{broken}), false, ""},
		{"limit", strings.NewReader(strings.Repeat("x", 8193)), false, "too_large"},
		{"imageOnly", bytes.NewReader(old), true, "preview_unavailable"},
		{"imageSize", bytes.NewReader(attachmentPNG(t, 2)), false, "too_large"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := store.UploadConditional("", "file.bin", tc.reader, tc.imageOnly, revision, false)
			if tc.code != "" {
				code(t, err, tc.code)
			} else if !errors.Is(err, broken) {
				t.Fatal(err)
			}
			attachmentBytes(t, root, "file.bin", old)
		})
	}
	limits.Image = 8192
	if err = store.SetLimits(limits); err != nil {
		t.Fatal(err)
	}
	_, _, err = store.UploadConditional("", "file.bin", bytes.NewReader(attachmentPNG(t, 2)), true, revision, false)
	code(t, err, "preview_unavailable")
	attachmentBytes(t, root, "file.bin", old)
	limits.Attachment = 3
	limits.Image, limits.PDF = 3, 3
	if err = store.SetLimits(limits); err != nil {
		t.Fatal(err)
	}
	_, _, err = store.UploadConditional("", "file.bin", bytes.NewReader(nil), false, revision, false)
	code(t, err, "too_large")
	attachmentBytes(t, root, "file.bin", old)
}

func TestAttachmentUploadQuotaReplacement(t *testing.T) {
	store, root := testStore(t)
	old := []byte{0, 1, 2, 3}
	_, revision, err := store.UploadConditional("", "file.bin", bytes.NewReader(old), false, "", true)
	if err != nil {
		t.Fatal(err)
	}
	quota := int64(4)
	store.SetQuota(func() (int64, error) { return quota, nil })
	next := []byte{255, 0, 2, 3}
	_, revision, err = store.UploadConditional("", "file.bin", bytes.NewReader(next), false, revision, false)
	if err != nil {
		t.Fatal("配额已满仍应允许等大小替换", err)
	}
	_, _, err = store.UploadConditional("", "file.bin", bytes.NewReader(append(next, 1)), false, revision, false)
	code(t, err, "quota_exceeded")
	attachmentBytes(t, root, "file.bin", next)
	quota = 0
	_, _, err = store.UploadConditional("", "file.bin", bytes.NewReader(next[:2]), false, revision, false)
	if err != nil {
		t.Fatal("超配额仍应允许缩小", err)
	}
	attachmentBytes(t, root, "file.bin", next[:2])
}

type attachmentHookReader struct {
	io.Reader
	once sync.Once
	hook func()
}

func (r *attachmentHookReader) Read(p []byte) (int, error) {
	r.once.Do(r.hook)
	return r.Reader.Read(p)
}

func TestAttachmentUploadRechecksVersionAndQuota(t *testing.T) {
	for _, change := range []string{"version", "quota", "parent"} {
		t.Run(change, func(t *testing.T) {
			store, root := testStore(t)
			if err := store.Mkdir("dir"); err != nil {
				t.Fatal(err)
			}
			_, revision, err := store.UploadConditional("dir", "file.bin", bytes.NewReader([]byte{0, 1}), false, "", true)
			if err != nil {
				t.Fatal(err)
			}
			quota := int64(10)
			store.SetQuota(func() (int64, error) { return quota, nil })
			reader := &attachmentHookReader{Reader: bytes.NewReader([]byte{0, 2, 3}), hook: func() {
				store.mu.Lock()
				if store.uploads["dir/file.bin"] != 1 {
					t.Error("未登记活动上传")
				}
				store.mu.Unlock()
				switch change {
				case "version":
					err = os.WriteFile(filepath.Join(root, "dir/file.bin"), []byte{0, 4}, 0o644)
				case "quota":
					quota = 2
				case "parent":
					err = os.Rename(filepath.Join(root, "dir"), filepath.Join(root, "moved"))
					if err == nil {
						err = os.Mkdir(filepath.Join(root, "dir"), 0o755)
					}
				}
				if err != nil {
					t.Fatal(err)
				}
			}}
			_, _, err = store.UploadConditional("dir", "file.bin", reader, false, revision, false)
			code(t, err, map[string]string{"version": "revision_conflict", "quota": "quota_exceeded", "parent": "file_changed"}[change])
			store.mu.Lock()
			if len(store.uploads) != 0 {
				t.Error("失败后遗留活动上传")
			}
			store.mu.Unlock()
			name, expected := "dir/file.bin", []byte{0, 1}
			if change == "parent" {
				name = "moved/file.bin"
			} else if change == "version" {
				expected = []byte{0, 4}
			}
			attachmentBytes(t, root, name, expected)
		})
	}
}

func TestAttachmentUploadConcurrentSamePath(t *testing.T) {
	for _, create := range []bool{true, false} {
		t.Run(map[bool]string{true: "create", false: "replace"}[create], func(t *testing.T) {
			store, root := testStore(t)
			revision := ""
			if !create {
				_, current, err := store.UploadConditional("", "file.bin", bytes.NewReader([]byte{0, 1}), false, "", true)
				if err != nil {
					t.Fatal(err)
				}
				revision = current
			}
			started := make(chan struct{}, 2)
			var release [2]chan struct{}
			var done [2]chan error
			for i := range release {
				release[i], done[i] = make(chan struct{}), make(chan error, 1)
				go func(i int) {
					reader := &attachmentHookReader{Reader: bytes.NewReader([]byte{0, byte(i + 2)}), hook: func() {
						started <- struct{}{}
						<-release[i]
					}}
					_, _, err := store.UploadConditional("", "file.bin", reader, false, revision, create)
					done[i] <- err
				}(i)
			}
			<-started
			<-started
			store.mu.Lock()
			if store.uploads["file.bin"] != 2 {
				t.Error("同路径并发上传计数错误")
			}
			store.mu.Unlock()
			close(release[0])
			first := <-done[0]
			store.mu.Lock()
			if store.uploads["file.bin"] != 1 {
				t.Error("首个上传结束后丢失另一个上传计数")
			}
			store.mu.Unlock()
			close(release[1])
			second := <-done[1]
			if first != nil {
				t.Fatal(first)
			}
			code(t, second, map[bool]string{true: "target_exists", false: "revision_conflict"}[create])
			if !create {
				var problem *Error
				if !errors.As(second, &problem) || problem.Revision != digest([]byte{0, 2}) {
					t.Fatal("并发冲突未返回最新版本", second)
				}
			}
			attachmentBytes(t, root, "file.bin", []byte{0, 2})
			store.mu.Lock()
			defer store.mu.Unlock()
			if len(store.uploads) != 0 {
				t.Fatal("并发结束后遗留上传计数")
			}
		})
	}
}
