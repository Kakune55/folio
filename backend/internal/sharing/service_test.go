package sharing

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"folio/internal/storage"
)

func fixture(t *testing.T) (*Service, map[int64]*storage.Store, map[int64]bool) {
	t.Helper()
	base := t.TempDir()
	stores := map[int64]*storage.Store{}
	enabled := map[int64]bool{1: true, 2: true}
	for _, id := range []int64{1, 2} {
		dir := filepath.Join(base, fmtID(id))
		os.Mkdir(dir, 0700)
		store, e := storage.Open(dir)
		if e != nil {
			t.Fatal(e)
		}
		stores[id] = store
		t.Cleanup(func() { store.Close() })
		store.SetQuota(func() (int64, error) { return 1 << 30, nil })
	}
	s, e := Open(base, func(id int64) (*storage.Store, bool, error) { return stores[id], enabled[id], nil })
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	for id, store := range stores {
		if e = s.EnsureOwner(id); e != nil {
			t.Fatal(e)
		}
		store.SetExtraUsage(func() (int64, error) { return s.Usage(id) })
	}
	return s, stores, enabled
}
func fmtID(id int64) string {
	if id == 1 {
		return "workspace1"
	}
	return "workspace2"
}
func write(t *testing.T, store *storage.Store, name, data string) {
	t.Helper()
	_, e := store.Write(name, data, "", true)
	if e != nil {
		t.Fatal(e)
	}
}
func input(t *testing.T, store *storage.Store, root, mode string, include bool) Input {
	t.Helper()
	scan, e := ScanFiles(store, root, include)
	if e != nil {
		t.Fatal(e)
	}
	return Input{Root: root, Title: root, Mode: mode, Files: scan.Files}
}
func status(t *testing.T, err error, want int) {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) || e.Status != want {
		t.Fatalf("错误 %v，预期 %d", err, want)
	}
}
func TestSnapshotRecursiveAuthorizationAndImport(t *testing.T) {
	s, stores, _ := fixture(t)
	store := stores[1]
	if e := store.Mkdir("docs"); e != nil {
		t.Fatal(e)
	}
	if e := store.Mkdir("assets"); e != nil {
		t.Fatal(e)
	}
	original := "# 根文档\r\n\r\n[下一篇](./next.md) ![图片](../assets/image.txt) [根引用](/assets/image.txt)\r\n\r\n`[伪引用](secret.txt)`\r\n\r\n<script>alert(1)</script>\r\n"
	write(t, store, "docs/root.md", original)
	write(t, store, "docs/next.md", "[返回](root.md) [文件][ref]\n\n[ref]: ../assets/image.txt\n")
	write(t, store, "assets/image.txt", "附件字节\x01")
	write(t, store, "secret.txt", "不公开")
	in := input(t, store, "docs/root.md", "snapshot", true)
	if len(in.Files) != 3 {
		t.Fatalf("递归清单 %+v", in.Files)
	}
	password := "001234"
	in.Password = &password
	in.MaxVisits = 1
	r, e := s.Save(1, "", in)
	if e != nil {
		t.Fatal(e)
	}
	if _, _, e = s.File(r.ID, "", r.Files[0].ID); e == nil {
		t.Fatal("匿名读取绕过授权")
	}
	_, _, e = s.Enter(r.ID, "bad", "", "local")
	status(t, e, 403)
	r, grant, e := s.Enter(r.ID, password, "", "local")
	if e != nil {
		t.Fatal(e)
	}
	if r.Visits != 1 {
		t.Fatal(r.Visits)
	}
	_, again, e := s.Enter(r.ID, "", grant, "local")
	if e != nil || again != grant {
		t.Fatal("刷新重复计数", e)
	}
	_, _, e = s.Enter(r.ID, password, "", "other")
	status(t, e, 410)
	_, _, e = s.File(r.ID, grant, "not-in-manifest")
	status(t, e, 404)
	raw, _, e := s.File(r.ID, grant, r.Files[0].ID)
	if e != nil || string(raw.Data) != original {
		t.Fatal("快照原始字节改变", e)
	}
	html, e := Render(raw.Path, raw.Data, r.ID, r.Files)
	if e != nil || strings.Contains(html, "<script>") || strings.Contains(html, "secret.txt\" href") {
		t.Fatal(html, e)
	}
	_, e = s.Import(r.ID, grant, r.Files[0].ID, 2, "收到的分享")
	if e != nil {
		t.Fatal(e)
	}
	transferred, e := stores[2].Read("收到的分享/docs/root.md")
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(transferred.Content, ".././assets/image.txt") || !strings.Contains(transferred.Content, "`[伪引用](secret.txt)`") || !strings.Contains(transferred.Content, "\r\n") {
		t.Fatal("引用或字节转存错误", transferred.Content)
	}
	copied, e := stores[2].Read("收到的分享/assets/image.txt")
	if e != nil || copied.Content != "附件字节\x01" {
		t.Fatal("附件未转存", e)
	}
	_, e = s.Import(r.ID, grant, r.Files[0].ID, 2, "收到的分享")
	var st *storage.Error
	if !errors.As(e, &st) || st.Code != "target_exists" {
		t.Fatal("转存覆盖", e)
	}
	if _, e = stores[2].Metadata("收到的分享/secret.txt"); e == nil {
		t.Fatal("转存未授权文件")
	}
	update := Input{Root: r.Root, Title: r.Title, Mode: r.Mode, Version: r.Version, MaxVisits: 1, Disabled: true}
	if _, e = s.Save(1, r.ID, update); e != nil {
		t.Fatal(e)
	}
	_, _, e = s.File(r.ID, grant, r.Files[0].ID)
	status(t, e, 410)
	if e = s.Delete(2, r.ID); e == nil {
		t.Fatal("跨用户删除")
	}
	before, _ := store.Usage()
	if e = s.Delete(1, r.ID); e != nil {
		t.Fatal(e)
	}
	after, _ := store.Usage()
	if before.Used <= after.Used {
		t.Fatal("删除未释放快照配额")
	}
}
func TestLiveCannotIncludeAttachmentsAndLatestFile(t *testing.T) {
	s, stores, enabled := fixture(t)
	store := stores[1]
	write(t, store, "main.md", "# 起初\n[附件](other.txt)\n")
	write(t, store, "other.txt", "私密附件")
	in := input(t, store, "main.md", "live", true)
	_, e := s.Save(1, "", in)
	status(t, e, 400)
	in = input(t, store, "main.md", "live", false)
	r, e := s.Save(1, "", in)
	if e != nil {
		t.Fatal(e)
	}
	r, grant, e := s.Enter(r.ID, "", "", "local")
	if e != nil {
		t.Fatal(e)
	}
	current, _ := store.Read("main.md")
	if _, e = store.Write("main.md", "# 最新\n[附件](other.txt)\n", current.Revision, false); e != nil {
		t.Fatal(e)
	}
	f, _, e := s.File(r.ID, grant, r.Files[0].ID)
	if e != nil || !bytes.Contains(f.Data, []byte("最新")) {
		t.Fatal(e)
	}
	html, e := Render(f.Path, f.Data, r.ID, r.Files)
	if e != nil || !strings.Contains(html, "#not-included") {
		t.Fatal(html, e)
	}
	in = input(t, store, "main.md", "live", true)
	in.Version = r.Version
	_, e = s.Save(1, r.ID, in)
	status(t, e, 400)
	enabled[1] = false
	_, _, e = s.File(r.ID, grant, r.Files[0].ID)
	status(t, e, 410)
}
func TestStaleSelectionQuotaAndLastVisit(t *testing.T) {
	s, stores, _ := fixture(t)
	store := stores[1]
	write(t, store, "file.txt", "原始正文")
	in := input(t, store, "file.txt", "snapshot", false)
	old, _ := store.Read("file.txt")
	store.Write("file.txt", "更新正文", old.Revision, false)
	_, e := s.Save(1, "", in)
	var st *storage.Error
	if !errors.As(e, &st) || st.Code != "revision_conflict" {
		t.Fatal("接受过时确认", e)
	}
	in = input(t, store, "file.txt", "snapshot", false)
	usage, _ := store.Usage()
	store.SetQuota(func() (int64, error) { return usage.Used, nil })
	_, e = s.Save(1, "", in)
	if !errors.As(e, &st) || st.Code != "quota_exceeded" {
		t.Fatal("快照未检查配额", e)
	}
	store.SetQuota(func() (int64, error) { return 1 << 30, nil })
	in.MaxVisits = 1
	r, e := s.Save(1, "", in)
	if e != nil {
		t.Fatal(e)
	}
	var successes atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, e := s.Enter(r.ID, "", "", "concurrent"); e == nil {
				successes.Add(1)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 1 {
		t.Fatalf("最后一次访问发放 %d 次", successes.Load())
	}
	r, e = s.load(r.ID)
	if e != nil || r.Visits != 1 {
		t.Fatal(r, e)
	}
	r.ExpiresAt = time.Now().Add(-time.Second).Unix()
	if e = s.save(r); e != nil {
		t.Fatal(e)
	}
	_, e = s.Info(r.ID)
	status(t, e, 410)
}
func TestMarkdownIsolationAndRelocation(t *testing.T) {
	data := []byte("# 标题\n![外部](https://evil.invalid/a.png)\n[脚本](javascript:alert%281%29)\n<img src=x onerror=alert(1)>\n\n````md\n[x](/assets/file.txt)\n````\n\n[文件](/assets/file.txt)\n")
	out, e := Render("docs/main.md", data, "token", nil)
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(out, `src="https:`) || strings.Contains(out, "<img src=x") || strings.Contains(out, `href="javascript:`) {
		t.Fatal(out)
	}
	relocated, err := Relocate("docs/main.md", data)
	if err != nil {
		t.Fatal(err)
	}
	moved := string(relocated)
	if !strings.Contains(moved, "````md\n[x](/assets/file.txt)") || !strings.Contains(moved, "[文件](.././assets/file.txt)") {
		t.Fatal(moved)
	}
	for _, href := range []string{"../../escape", "../%2e%2e/escape", "/../escape", "file.txt%00"} {
		if _, e := Resolve("a.md", href); e == nil {
			t.Fatalf("接受越界 %s", href)
		}
	}
}

func TestGrantRestartPasswordRateLimitAndSnapshotIntegrity(t *testing.T) {
	s, stores, _ := fixture(t)
	write(t, stores[1], "a.txt", "稳定快照")
	in := input(t, stores[1], "a.txt", "snapshot", false)
	password := "123456"
	in.Password = &password
	r, e := s.Save(1, "", in)
	if e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 5; i++ {
		_, _, e = s.Enter(r.ID, "000000", "", "guess")
		status(t, e, 403)
	}
	_, _, e = s.Enter(r.ID, password, "", "guess")
	status(t, e, 429)
	_, grant, e := s.Enter(r.ID, password, "", "other")
	if e != nil {
		t.Fatal(e)
	}
	directory := filepath.Dir(s.root.Name())
	source := s.source
	if e = s.Close(); e != nil {
		t.Fatal(e)
	}
	reopened, e := Open(directory, source)
	if e != nil {
		t.Fatal(e)
	}
	defer reopened.Close()
	loaded, e := reopened.Manifest(r.ID, grant)
	if e != nil || loaded.Visits != 1 {
		t.Fatal("重启丢失授权或计数", e)
	}
	if e = os.WriteFile(filepath.Join(reopened.root.Name(), r.Payload, "a.txt"), []byte("被篡改的快照"), 0600); e != nil {
		t.Fatal(e)
	}
	_, _, e = reopened.File(r.ID, grant, r.Files[0].ID)
	var problem *storage.Error
	if !errors.As(e, &problem) || problem.Code != "revision_conflict" {
		t.Fatal("快照损坏仍可读取", e)
	}
}

func TestBinaryRemainsBinaryInSnapshot(t *testing.T) {
	s, stores, _ := fixture(t)
	if _, e := stores[1].Upload("", "binary.bin", bytes.NewReader([]byte{0, 1, 255, 128}), false); e != nil {
		t.Fatal(e)
	}
	in := input(t, stores[1], "binary.bin", "snapshot", false)
	if in.Files[0].Metadata.Viewer != "binary" {
		t.Fatal("二进制被错误识别为正文", in.Files[0].Metadata)
	}
	r, e := s.Save(1, "", in)
	if e != nil {
		t.Fatal(e)
	}
	_, grant, e := s.Enter(r.ID, "", "", "local")
	if e != nil {
		t.Fatal(e)
	}
	f, _, e := s.File(r.ID, grant, r.Files[0].ID)
	if e != nil || f.Metadata.Viewer != "binary" || !bytes.Equal(f.Data, []byte{0, 1, 255, 128}) {
		t.Fatal("快照类型或原件不符", f.Metadata, e)
	}
}

func TestBrowserGrantSharedAcrossLinksAndLiveRootIdentity(t *testing.T) {
	s, stores, _ := fixture(t)
	write(t, stores[1], "one.txt", "内容一")
	write(t, stores[1], "two.txt", "内容二")
	first, e := s.Save(1, "", input(t, stores[1], "one.txt", "live", false))
	if e != nil {
		t.Fatal(e)
	}
	_, token, e := s.Enter(first.ID, "", "", "local")
	if e != nil {
		t.Fatal(e)
	}
	second, e := s.Save(1, "", input(t, stores[1], "two.txt", "snapshot", false))
	if e != nil {
		t.Fatal(e)
	}
	page, total, err := s.List(1, 1, 1)
	if err != nil || total != 2 || len(page) != 1 || page[0].ID != first.ID {
		t.Fatal("分页顺序或范围错误", page, total, err)
	}
	_, same, e := s.Enter(second.ID, "", token, "local")
	if e != nil || token != same {
		t.Fatal("多分享未共用访客 Cookie", e)
	}
	if _, e = s.Manifest(first.ID, token); e != nil {
		t.Fatal("进入另一分享丢失旧授权", e)
	}
	dir := t.TempDir()
	replacement, e := storage.Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer replacement.Close()
	old := stores[1]
	stores[1] = replacement
	defer func() { stores[1] = old }()
	_, e = s.Manifest(first.ID, token)
	status(t, e, 410)
	// 快照独立于来源工作区身份，仍可读取。
	if _, e = s.Manifest(second.ID, token); e != nil {
		t.Fatal("来源变化损坏快照授权", e)
	}
}

func TestRelocationOnlyTouchesParsedURLSpans(t *testing.T) {
	original := "\\[纯文本](/a.txt)\r\n\r\n[实际链接](/a.txt)\r\n\r\n`[代码](/a.txt)`\r\n\r\n[引用][ref]\r\n\r\n[ref]: /a.txt\r\n"
	relocated, e := Relocate("docs/note.md", []byte(original))
	if e != nil {
		t.Fatal(e)
	}
	expected := "\\[纯文本](/a.txt)\r\n\r\n[实际链接](.././a.txt)\r\n\r\n`[代码](/a.txt)`\r\n\r\n[引用][ref]\r\n\r\n[ref]: .././a.txt\r\n"
	if string(relocated) != expected {
		t.Fatalf("改写了非链接正文：%q", relocated)
	}
}

func TestEscapedLocalReferencesAndBoundedAuthorization(t *testing.T) {
	s, stores, _ := fixture(t)
	store := stores[1]
	write(t, store, "main.md", "[文件](图\\(1\\).txt)\n")
	write(t, store, "图(1).txt", "原件")
	in := input(t, store, "main.md", "snapshot", true)
	if len(in.Files) != 2 {
		t.Fatal("未识别标准转义链接", in.Files)
	}
	r, e := s.Save(1, "", in)
	if e != nil {
		t.Fatal(e)
	}
	entries, total, e := s.List(1, 0, 1)
	if e != nil || len(entries) != 1 || total != 1 {
		t.Fatal("分页失败", entries, total, e)
	}
	_, e = s.db.Exec(`WITH RECURSIVE numbers(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM numbers WHERE x<10000)
 INSERT INTO grants(token,share_id,version,expires) SELECT printf('%064x',x),'reserved','v',? FROM numbers`, time.Now().Add(time.Hour).Unix())
	if e != nil {
		t.Fatal(e)
	}
	_, _, e = s.Enter(r.ID, "", "", "local")
	status(t, e, 429)
	current, e := s.load(r.ID)
	if e != nil || current.Visits != 0 {
		t.Fatal("容量不足仍扣减访问次数", e)
	}
	store.SetQuota(func() (int64, error) { return 1 << 30, nil })
}

func TestPauseResumePreservesRestrictions(t *testing.T) {
	s, stores, _ := fixture(t)
	write(t, stores[1], "pause.txt", "snapshot")
	in := input(t, stores[1], "pause.txt", "snapshot", false)
	in.ExpiresAt = time.Now().Add(time.Hour).Unix()
	in.MaxVisits = 3
	r, err := s.Save(1, "", in)
	if err != nil {
		t.Fatal(err)
	}
	_, grant, err := s.Enter(r.ID, "", "", "pause-test")
	if err != nil {
		t.Fatal(err)
	}
	r, _ = s.load(r.ID)
	settings := Input{Root: r.Root, Title: r.Title, Mode: r.Mode, ExpiresAt: r.ExpiresAt, MaxVisits: r.MaxVisits, Version: r.Version, Disabled: true}
	paused, err := s.Save(1, r.ID, settings)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = s.File(r.ID, grant, r.Files[0].ID)
	status(t, err, 410)
	settings.Version = paused.Version
	settings.Disabled = false
	resumed, err := s.Save(1, r.ID, settings)
	if err != nil {
		t.Fatal(err)
	}
	if resumed.ID != r.ID || resumed.Payload != r.Payload || resumed.ExpiresAt != r.ExpiresAt || resumed.MaxVisits != 3 || resumed.Visits != 1 {
		t.Fatal("继续改变了原分享", resumed)
	}
	_, newGrant, err := s.Enter(r.ID, "", "", "resume-test")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.File(r.ID, newGrant, r.Files[0].ID); err != nil {
		t.Fatal(err)
	}
	// 直接推进记录至过期，避免依赖墙钟等待。
	resumed, _ = s.load(r.ID)
	resumed.ExpiresAt = time.Now().Add(-time.Minute).Unix()
	if err = s.save(resumed); err != nil {
		t.Fatal(err)
	}
	settings.ExpiresAt = resumed.ExpiresAt
	settings.Version = resumed.Version
	settings.Disabled = true
	// 陈旧页面不能在后台清理前续期或恢复已到期的分享。
	settings.ExpiresAt = time.Now().Add(time.Hour).Unix()
	_, err = s.Save(1, r.ID, settings)
	status(t, err, 410)
	_, err = s.load(r.ID)
	status(t, err, 404)
	in.ExpiresAt = resumed.ExpiresAt
	_, err = s.Save(1, "", in)
	status(t, err, 400)
}
