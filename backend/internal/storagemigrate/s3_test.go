package storagemigrate

import (
	"context"
	"folio/internal/auth"
	"folio/internal/s3test"
	"folio/internal/sharing"
	"folio/internal/storage"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestLocalToS3PreservesIdentityFilesAndShares(t *testing.T) {

	fake := &s3test.Server{Objects: map[string]s3test.Object{}}
	server := httptest.NewServer(fake)
	defer server.Close()
	opts := storage.S3Options{AccessKey: "test-key", SecretKey: "test-secret", Bucket: "bucket", Prefix: "folio", Endpoint: server.URL, PathStyle: true}
	base := t.TempDir()
	w := filepath.Join(base, "workspace")
	d := filepath.Join(base, "data")
	for _, dir := range []string{w, d} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	a, err := auth.Open(d, password)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	backend, err := storage.NewLocal(w, d, a.Database())
	if err != nil {
		t.Fatal(err)
	}
	source, err := backend.OpenUser(1)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	defer backend.Close()
	identity, err := source.Identity()
	if err != nil {
		t.Fatal(err)
	}
	original := "\ufeff# 原文\r\n不能改写\r"
	rev, err := source.Write("note.md", original, "", true)
	if err != nil {
		t.Fatal(err)
	}
	if err = source.Mkdir("deleted"); err != nil {
		t.Fatal(err)
	}
	if _, err = source.Write("deleted/child.md", "回收目录原文", "", true); err != nil {
		t.Fatal(err)
	}
	dirRev, e := source.EntryRevision("deleted")
	if e != nil {
		t.Fatal(e)
	}
	trashRecord, e := source.Trash("deleted", dirRev.Revision)
	if e != nil {
		t.Fatal(e)
	}
	shares, err := sharing.Open(a.Database(), func(int64) (storage.Workspace, bool, error) { return source, true, nil })
	if err != nil {
		t.Fatal(err)
	}
	defer shares.Close()
	makeShare := func(mode string) *sharing.Record {
		r, e := shares.Save(1, "", sharing.Input{Title: "测试分享", Root: "note.md", Mode: mode, Files: []storage.BundleFile{{Path: "note.md", Revision: rev}}})
		if e != nil {
			t.Fatal(e)
		}
		return r
	}
	live := makeShare("live")
	snap := makeShare("snapshot")
	_, grant, err := shares.Enter(snap.ID, "", "", "test")
	if err != nil {
		t.Fatal(err)
	}
	shares.Close()
	source.Close()
	backend.Close()
	a.Close()
	fake.Mu.Lock()
	fake.FailPut = "note.md"
	fake.Mu.Unlock()
	if err = ToS3(w, d, opts); err == nil {
		t.Fatal("注入上传故障未阻止切换")
	}
	a, err = auth.Open(d, "")
	if err != nil {
		t.Fatal(err)
	}
	if err = storage.BindBackend(a.Database(), "local"); err != nil {
		t.Fatal("失败后已切换后端", err)
	}
	a.Close()
	fake.Mu.Lock()
	fake.FailPut = ""
	fake.Mu.Unlock()
	if err = ToS3(w, d, opts); err != nil {
		t.Fatal(err)
	}
	if err = ToS3(w, d, opts); err == nil {
		t.Fatal("切换后重新导入旧数据")
	}
	originalFile, err := os.ReadFile(filepath.Join(w, "1", "note.md"))
	if err != nil || string(originalFile) != original {
		t.Fatal("原件未保留", err)
	}
	a, err = auth.Open(d, "")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	remote, err := storage.NewS3(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if err = storage.BindBackend(a.Database(), remote.Binding()); err != nil {
		t.Fatal(err)
	}
	s, err := remote.OpenUser(1)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.Identity()
	if err != nil || got != identity {
		t.Fatal("迁移改变身份", got, identity, err)
	}
	if _, err = s.Restore(trashRecord.ID); err != nil {
		t.Fatal("目录回收记录迁移后不可恢复", err)
	}
	restoredChild, e := s.Read("deleted/child.md")
	if e != nil || restoredChild.Content != "回收目录原文" {
		t.Fatal(restoredChild, e)
	}
	content, err := s.Read("note.md")
	if err != nil || content.Content != original || content.Revision != rev {
		t.Fatal(content, err)
	}
	restored, err := sharing.Open(a.Database(), func(int64) (storage.Workspace, bool, error) { return s, true, nil })
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if _, err = restored.Info(live.ID); err != nil {
		t.Fatal("实时分享身份失效", err)
	}
	f, _, err := restored.File(snap.ID, grant, snap.Files[0].ID)
	if err != nil || string(f.Data) != original {
		t.Fatal("快照或旧授权失效", err)
	}
	// 再次回收目录，覆盖远端到本地的目录版本转换。
	entry, e := s.EntryRevision("deleted")
	if e != nil {
		t.Fatal(e)
	}
	recycled, e := s.Trash("deleted", entry.Revision)
	if e != nil {
		t.Fatal(e)
	}
	restored.Close()
	remote.Close()
	a.Close()
	if err = Between(w, d, "s3", "local", opts, nil); err == nil {
		t.Fatal("接管了非空旧工作区")
	}
	destination := filepath.Join(base, "returned")
	// 中断留下的不同文件不能被重试静默覆盖，绑定仍指向 S3。
	conflict := filepath.Join(destination, "1", "note.md")
	injected := false
	err = Between(destination, d, "s3", "local", opts, func(p storage.TransferProgress) {
		if !injected && p.Stage == "扫描" {
			injected = true
			if e := os.MkdirAll(filepath.Dir(conflict), 0700); e != nil {
				t.Fatal(e)
			}
			if e := os.WriteFile(conflict, []byte("冲突内容"), 0600); e != nil {
				t.Fatal(e)
			}
		}
	})
	if err == nil {
		t.Fatal("覆盖了不同的目标文件")
	}
	unchanged, e := os.ReadFile(conflict)
	if e != nil || string(unchanged) != "冲突内容" {
		t.Fatal("冲突文件已被覆盖", e)
	}
	check, e := auth.Open(d, "")
	if e != nil {
		t.Fatal(e)
	}
	if e = storage.BindBackend(check.Database(), remote.Binding()); e != nil {
		t.Fatal("失败后绑定被切换", e)
	}
	check.Close()
	if e = os.Remove(conflict); e != nil {
		t.Fatal(e)
	}
	events := 0
	if err = Between(destination, d, "s3", "local", opts, func(p storage.TransferProgress) {
		events++
		if p.Done > p.Total {
			t.Fatalf("错误进度 %+v", p)
		}
	}); err != nil {
		t.Fatal(err)
	}
	if events == 0 {
		t.Fatal("缺少迁移进度")
	}
	a, err = auth.Open(d, "")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	local, err := storage.NewLocal(destination, d, a.Database())
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	back, err := local.OpenUser(1)
	if err != nil {
		t.Fatal(err)
	}
	defer back.Close()
	got, err = back.Identity()
	if err != nil || got != identity {
		t.Fatal("往返身份变化", got, err)
	}
	body, err := back.Read("note.md")
	if err != nil || body.Content != original {
		t.Fatal("往返原文变化", body, err)
	}
	if _, err = back.Restore(recycled.ID); err != nil {
		t.Fatal("迁回后目录无法恢复", err)
	}
	shared, err := sharing.Open(a.Database(), func(int64) (storage.Workspace, bool, error) { return back, true, nil })
	if err != nil {
		t.Fatal(err)
	}
	defer shared.Close()
	if _, err = shared.Info(live.ID); err != nil {
		t.Fatal("迁回后实时分享失效", err)
	}
	snapshot, _, err := shared.File(snap.ID, grant, snap.Files[0].ID)
	if err != nil || string(snapshot.Data) != original {
		t.Fatal("迁回后快照或授权失效", err)
	}

}
