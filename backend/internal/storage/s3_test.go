package storage

import (
	"context"
	"fmt"
	"folio/internal/s3test"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func newRemote(t *testing.T) (*S3Backend, *s3test.Server, S3Options) {
	t.Helper()

	fake := &s3test.Server{Objects: map[string]s3test.Object{}}
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	opts := S3Options{AccessKey: "test-key", SecretKey: "test-secret", Bucket: "bucket", Endpoint: server.URL, Region: "us-east-1", Prefix: "folio", PathStyle: true}
	backend, err := NewS3(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	return backend, fake, opts
}
func TestS3WorkspaceRoundTripAndIsolation(t *testing.T) {
	b, f, _ := newRemote(t)
	w, err := b.OpenUser(1)
	if err != nil {
		t.Fatal(err)
	}
	w.SetQuota(func() (int64, error) { return 10000, nil })
	if err = w.Mkdir("笔记"); err != nil {
		t.Fatal(err)
	}
	source := "\ufeff# 原文\r\n下一行\r"
	rev, err := w.Write("笔记/a.md", source, "", true)
	if err != nil {
		t.Fatal(err)
	}
	content, err := w.Read("笔记/a.md")
	if err != nil || content.Content != source || content.Revision != rev {
		t.Fatal(content, err)
	}
	_, err = w.Write("笔记/a.md", "覆盖", "", true)
	code(t, err, "target_exists")
	_, err = w.Write("笔记/a.md", "覆盖", "stale", false)
	code(t, err, "revision_conflict")
	if _, err = w.Read(".folio/layout"); err == nil {
		t.Fatal("内部路径可读")
	}
	if err = w.Mkdir("笔记/a.md/child"); err == nil {
		t.Fatal("文件被当成目录")
	}
	download, m, err := w.ReadDownload("笔记/a.md", false, 1000)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(download)
	download.Close()
	if string(body) != source || m.Viewer != "markdown" {
		t.Fatal(string(body), m)
	}
	entries, n, err := w.List("", 0, 100)
	if err != nil || n != 1 || entries[0].Name != "笔记" {
		t.Fatal(entries, n, err)
	}
	result, err := w.EntryRevision("笔记")
	if err != nil {
		t.Fatal(err)
	}
	if err = w.Move("笔记", "归档", result.Revision); err != nil {
		t.Fatal(err)
	}
	rec, err := w.Trash("归档/a.md", rev)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = w.Read("归档/a.md"); !isCode(err, "not_found") {
		t.Fatal(err)
	}
	u, err := w.Usage()
	if err != nil || u.Used != int64(len(source)) {
		t.Fatal(u, err)
	}
	if _, err = w.Restore(rec.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = w.Restore(rec.ID); !isCode(err, "trash_not_found") {
		t.Fatal(err)
	}
	all, err := w.ReadBundle([]BundleFile{{Path: "归档/a.md", Revision: rev}})
	if err != nil {
		t.Fatal(err)
	}
	committed := false
	if err = w.PublishSnapshot("snapshot", all, func() error { committed = true; return nil }); err != nil || !committed {
		t.Fatal(err)
	}
	snapshot, err := w.ReadSnapshot("snapshot", []BundleFile{{Path: "归档/a.md", Revision: rev}})
	if err != nil || string(snapshot[0].Data) != source {
		t.Fatal(snapshot, err)
	}
	if _, err = w.ImportBundle("转存", snapshot); err != nil {
		t.Fatal(err)
	}
	detail, err := w.StorageDetails(context.Background())
	if err != nil || detail.Used != int64(3*len(source)) {
		t.Fatal(detail, err)
	}
	other, err := b.OpenUser(2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = other.Read("归档/a.md"); !isCode(err, "not_found") {
		t.Fatal(err)
	}
	if err = w.RemoveSnapshot("snapshot"); err != nil {
		t.Fatal(err)
	}
	f.Mu.Lock()
	Pages := f.Pages
	f.Mu.Unlock()
	if Pages < 2 {
		t.Fatal("没有实际覆盖分页")
	}
}
func TestS3RecoverInterruptedMoveBeforeReads(t *testing.T) {
	b, f, opts := newRemote(t)
	w, err := b.OpenUser(1)
	if err != nil {
		t.Fatal(err)
	}
	if err = w.Mkdir("src"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a.md", "b.md"} {
		if _, err = w.Write("src/"+name, name, "", true); err != nil {
			t.Fatal(err)
		}
	}
	rev, err := w.EntryRevision("src")
	if err != nil {
		t.Fatal(err)
	}
	f.Mu.Lock()
	f.FailDelete = "src/b.md"
	f.Mu.Unlock()
	if err = w.Move("src", "dst", rev.Revision); err == nil {
		t.Fatal("注入的删除故障未报告")
	}
	if _, _, err = w.List("", 0, 100); err == nil {
		t.Fatal("故障未解除时暴露半完成目录")
	}
	f.Mu.Lock()
	f.FailDelete = ""
	f.Mu.Unlock()
	reopened, err := NewS3(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := reopened.OpenUser(1)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a.md", "b.md"} {
		c, e := restored.Read("dst/" + name)
		if e != nil || c.Content != name {
			t.Fatal(c, e)
		}
	}
	entries, n, err := restored.List("", 0, 100)
	if err != nil || n != 1 || entries[0].Name != "dst" {
		t.Fatal(entries, n, err)
	}
	f.Mu.Lock()
	defer f.Mu.Unlock()
	for key := range f.Objects {
		if strings.Contains(key, "/operations/") {
			t.Fatal("恢复后遗留日志", key)
		}
	}
}
func TestS3RejectsUnsupportedConditionsAndConcurrentOverwrite(t *testing.T) {
	b, f, _ := newRemote(t)
	f.IgnoreConditions = true
	if _, err := b.OpenUser(1); err == nil {
		t.Fatal("接受不执行条件请求的服务")
	}
	f.IgnoreConditions = false
	w, err := b.OpenUser(1)
	if err != nil {
		t.Fatal(err)
	}
	rev, err := w.Write("a.md", "original", "", true)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	success := 0
	var mu sync.Mutex
	for range 4 {
		wg.Go(func() {
			_, e := w.Write("a.md", "next", rev, false)
			if e == nil {
				mu.Lock()
				success++
				mu.Unlock()
			} else if !isCode(e, "revision_conflict") {
				t.Error(e)
			}
		})
	}
	wg.Wait()
	if success != 1 {
		t.Fatal(success)
	}
}

func TestS3QuotaRestoreCollisionAndPurge(t *testing.T) {
	b, _, _ := newRemote(t)
	w, err := b.OpenUser(1)
	if err != nil {
		t.Fatal(err)
	}
	w.SetQuota(func() (int64, error) { return 6, nil })
	rev, err := w.Write("a.md", "123456", "", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = w.Write("b.md", "x", "", true); !isCode(err, "quota_exceeded") {
		t.Fatal(err)
	}
	rec, err := w.Trash("a.md", rev)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = w.Write("b.md", "x", "", true); !isCode(err, "quota_exceeded") {
		t.Fatal("回收释放了额度", err)
	}
	w.SetQuota(func() (int64, error) { return 10, nil })
	if _, err = w.Write("a.md", "new", "", true); err != nil {
		t.Fatal(err)
	}
	if _, err = w.Restore(rec.ID); !isCode(err, "target_exists") {
		t.Fatal("还原覆盖同名文件", err)
	}
	content, err := w.Read("a.md")
	if err != nil || content.Content != "new" {
		t.Fatal(content, err)
	}
	if err = w.Purge(rec.ID); err != nil {
		t.Fatal(err)
	}
	u, err := w.Usage()
	if err != nil || u.Used != 3 {
		t.Fatal(u, err)
	}
}

func TestS3RefusesDamagedTrashAndBundlePathCollision(t *testing.T) {
	b, f, _ := newRemote(t)
	w, err := b.OpenUser(1)
	if err != nil {
		t.Fatal(err)
	}
	rev, err := w.Write("a.md", "original", "", true)
	if err != nil {
		t.Fatal(err)
	}
	rec, err := w.Trash("a.md", rev)
	if err != nil {
		t.Fatal(err)
	}
	f.Mu.Lock()
	key := "folio/1/.folio/trash/" + rec.ID + "/payload"
	obj := f.Objects[key]
	obj.Data = []byte("损坏")
	f.Objects[key] = obj
	f.Mu.Unlock()
	if _, err = w.Restore(rec.ID); !isCode(err, "trash_damaged") {
		t.Fatal("损坏载荷被发布", err)
	}
	if _, err = w.ImportBundle("invalid", []BundleFile{{Path: "a", Data: []byte("file")}, {Path: "a/b", Data: []byte("child")}}); !isCode(err, "path_invalid") {
		t.Fatal("发布了文件/目录同名冲突", err)
	}
}

func TestMinioStaticSigningAndConditionalDelete(t *testing.T) {
	fake := &s3test.Server{Objects: map[string]s3test.Object{}}
	var mu sync.Mutex
	var signedPut, signedDelete bool
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		if r.Method == "PUT" && strings.Contains(r.Header.Get("Authorization"), "Credential=folio-key/") {
			signedPut = true
		}
		if r.Method == "DELETE" {
			if r.Header.Get("If-Match") == "" || !strings.Contains(r.URL.Query().Get("X-Amz-SignedHeaders"), "if-match") || !strings.HasPrefix(r.URL.Query().Get("X-Amz-Credential"), "folio-key/") {
				t.Error("条件删除未绑定签名头和显式 Key")
			}
			signedDelete = true
		}
		mu.Unlock()
		fake.ServeHTTP(w, r)
	}))
	defer endpoint.Close()
	backend, err := NewS3(context.Background(), S3Options{AccessKey: "folio-key", SecretKey: "folio-secret", Bucket: "bucket", Endpoint: endpoint.URL, PathStyle: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = backend.OpenUser(1); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if !signedPut || !signedDelete {
		t.Fatal("没有覆盖静态签名或条件删除")
	}
}

func TestMinioReadsEmptyAndSmallObjects(t *testing.T) {
	b, _, _ := newRemote(t)
	w, err := b.OpenUser(1)
	if err != nil {
		t.Fatal(err)
	}
	for _, size := range []int{0, 1, 2, 3, 4, 511, 512, 513} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			name := fmt.Sprintf("size-%d.md", size)
			body := strings.Repeat("x", size)
			rev, e := w.Write(name, body, "", true)
			if e != nil {
				t.Fatal(e)
			}
			content, e := w.Read(name)
			if e != nil || content.Content != body || content.Revision != rev {
				t.Fatal("小对象原始字节不一致", e)
			}
		})
	}
}

func TestMinioReadRejectsVersionChangeBetweenMetadataAndBody(t *testing.T) {
	fake := &s3test.Server{Objects: map[string]s3test.Object{}}
	var mu sync.Mutex
	change := false
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		mutate := change && r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/a.md")
		if mutate {
			change = false
		}
		mu.Unlock()
		if mutate {
			fake.Mu.Lock()
			o := fake.Objects["1/a.md"]
			o.Data = []byte("changed")
			o.ETag = "\"changed-version\""
			fake.Objects["1/a.md"] = o
			fake.Mu.Unlock()
		}
		fake.ServeHTTP(w, r)
	}))
	defer endpoint.Close()
	backend, err := NewS3(context.Background(), S3Options{AccessKey: "test-key", SecretKey: "test-secret", Bucket: "bucket", Endpoint: endpoint.URL, PathStyle: true})
	if err != nil {
		t.Fatal(err)
	}
	store, err := backend.OpenUser(1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.Write("a.md", "original", "", true); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	change = true
	mu.Unlock()
	if _, err = store.Read("a.md"); !isCode(err, "revision_conflict") {
		t.Fatal("版本变化后交付了混合读取结果", err)
	}
}
