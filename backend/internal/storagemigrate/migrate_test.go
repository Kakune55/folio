package storagemigrate

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"folio/internal/auth"
	"folio/internal/layout"
	"folio/internal/sharing"
	"folio/internal/storage"
	"folio/internal/trash"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const password = "migration-password-123"

func legacy(t *testing.T) (string, string, string, string) {
	t.Helper()
	base := t.TempDir()
	w := filepath.Join(base, "workspace")
	d := filepath.Join(base, "data")
	for _, dir := range []string{w, d, filepath.Join(w, "1"), filepath.Join(d, "shares", "1", "snapshot")} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	a, err := auth.Open(d, password)
	if err != nil {
		t.Fatal(err)
	}
	a.Close()
	s, err := storage.Open(filepath.Join(w, "1"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	bin, err := trash.Open(filepath.Join(d, "1", "trash"))
	if err != nil {
		t.Fatal(err)
	}
	defer bin.Close()
	s.SetTrash(bin)
	rev, err := s.Write("回收.md", "原始\r\n正文", "", true)
	if err != nil {
		t.Fatal(err)
	}
	rec, err := s.Trash("回收.md", rev)
	if err != nil {
		t.Fatal(err)
	}
	body := []byte("快照\r\n原文")
	sum := sha256.Sum256(body)
	if err = os.WriteFile(filepath.Join(d, "shares", "1", "snapshot", "note.md"), body, 0600); err != nil {
		t.Fatal(err)
	}
	old, err := sql.Open("sqlite", filepath.Join(d, "shares", "shares.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	if err = sharing.InitSchema(old); err != nil {
		t.Fatal(err)
	}
	record := sharing.Record{ID: "abcdefghijklmnop", Root: "note.md", Mode: "snapshot", Version: strings.Repeat("a", 48), MaxVisits: 5, Visits: 1, Files: []sharing.File{{ID: strings.Repeat("b", 48), Path: "note.md", Revision: "sha256:" + hex.EncodeToString(sum[:]), Size: int64(len(body))}}}
	raw, _ := json.Marshal(record)
	if _, err = old.Exec("INSERT INTO shares(id,owner,record,payload) VALUES(?,1,?,?)", record.ID, string(raw), "1/snapshot"); err != nil {
		t.Fatal(err)
	}
	token := strings.Repeat("c", 48)
	h := sha256.Sum256([]byte(token))
	if _, err = old.Exec("INSERT INTO grants VALUES(?,?,?,?)", hex.EncodeToString(h[:]), record.ID, record.Version, time.Now().Add(time.Hour).Unix()); err != nil {
		t.Fatal(err)
	}
	return w, d, rec.ID, token
}
func TestMigrationPreservesContentSharesAndOriginals(t *testing.T) {
	w, d, id, token := legacy(t)
	// 原件保留，目标冲突时中止；消除冲突后同一命令可继续。
	roots, err := os.OpenRoot(w)
	if err != nil {
		t.Fatal(err)
	}
	if err = layout.EnsureOwner(roots, 1); err != nil {
		t.Fatal(err)
	}
	roots.Close()
	target := filepath.Join(w, "1", ".folio", "shares", "snapshot")
	if err = os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(target, "note.md"), []byte("冲突"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = Run(w, d); err == nil {
		t.Fatal("迁移覆盖了目标冲突")
	}
	if err = os.Remove(filepath.Join(target, "note.md")); err != nil {
		t.Fatal(err)
	}
	if err = Run(w, d); err != nil {
		t.Fatal(err)
	}
	if err = Run(w, d); err == nil {
		t.Fatal("已切换布局重新导入旧数据")
	}
	for _, name := range []string{filepath.Join(d, "1", "trash", id, "payload"), filepath.Join(d, "shares", "1", "snapshot", "note.md"), filepath.Join(d, "shares", "shares.db")} {
		if _, err = os.Stat(name); err != nil {
			t.Fatal(err)
		}
	}
	a, err := auth.Open(d, "")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	s, err := storage.Open(filepath.Join(w, "1"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	bin, err := trash.Open(filepath.Join(w, "1", ".folio", "trash"))
	if err != nil {
		t.Fatal(err)
	}
	defer bin.Close()
	s.SetTrash(bin)
	if _, err = s.Restore(id); err != nil {
		t.Fatal(err)
	}
	content, err := s.Read("回收.md")
	if err != nil || content.Content != "原始\r\n正文" {
		t.Fatal(content, err)
	}
	shares, err := sharing.Open(a.Database(), func(int64) (storage.Workspace, bool, error) { return s, true, nil })
	if err != nil {
		t.Fatal(err)
	}
	defer shares.Close()
	r, err := shares.Manifest("abcdefghijklmnop", token)
	if err != nil || r.Visits != 1 {
		t.Fatal(r, err)
	}
	f, _, err := shares.File(r.ID, token, r.Files[0].ID)
	if err != nil || string(f.Data) != "快照\r\n原文" {
		t.Fatal(f, err)
	}
	// 服务关闭不得关闭核心库。
	if err = shares.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = a.User(1); err != nil {
		t.Fatal(err)
	}
}
func TestMigrationRejectsRunningAndReservedContent(t *testing.T) {
	w, d, _, _ := legacy(t)
	a, err := auth.Open(d, "")
	if err != nil {
		t.Fatal(err)
	}
	if err = Run(w, d); err == nil {
		t.Fatal("运行中迁移未被实例锁阻止")
	}
	a.Close()
	if err = os.Mkdir(filepath.Join(w, "1", ".folio"), 0700); err != nil {
		t.Fatal(err)
	}
	if err = Run(w, d); err == nil {
		t.Fatal("接管了用户 .folio 目录")
	}
	if _, err = os.Stat(filepath.Join(w, "1", ".folio", "layout")); !os.IsNotExist(err) {
		t.Fatal("改写了用户冲突目录", err)
	}
}
func TestMigrationRejectsCorruptSnapshot(t *testing.T) {
	w, d, _, _ := legacy(t)
	if err := os.WriteFile(filepath.Join(d, "shares", "1", "snapshot", "note.md"), []byte("损坏"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := Run(w, d); err == nil {
		t.Fatal("损坏快照被标记迁移完成")
	}
	a, err := auth.Open(d, "")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	complete, err := layout.Complete(a.Database())
	if err != nil || complete {
		t.Fatal(complete, err)
	}
	var n int
	if err = a.Database().QueryRow("SELECT count(*) FROM shares").Scan(&n); err != nil || n != 0 {
		t.Fatal("失败迁移留下半提交分享记录", n, err)
	}
}

func TestMigrationImportsCommittedWALAndRejectsOrphanGrants(t *testing.T) {
	w, d, _, _ := legacy(t)
	old, err := sql.Open("sqlite", filepath.Join(d, "shares", "shares.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	if _, err = old.Exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;"); err != nil {
		t.Fatal(err)
	}
	if _, err = old.Exec("INSERT INTO grants VALUES('orphan','missing','version',1)"); err != nil {
		t.Fatal(err)
	}
	if err = Run(w, d); err == nil {
		t.Fatal("孤立资格没有阻止事务切换")
	}
	if _, err = old.Exec("DELETE FROM grants WHERE share_id='missing'; INSERT INTO grants VALUES('wal-token','abcdefghijklmnop','wal-version',1)"); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(d, "shares", "shares.db-wal")); err != nil {
		t.Fatal(err)
	}
	if err = Run(w, d); err != nil {
		t.Fatal(err)
	}
	a, err := auth.Open(d, "")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	var n int
	if err = a.Database().QueryRow("SELECT count(*) FROM grants WHERE token='wal-token'").Scan(&n); err != nil || n != 1 {
		t.Fatal("遗漏 WAL 中已提交数据", n, err)
	}
}
func TestCopyTreeResumesUnpublishedFile(t *testing.T) {
	source := t.TempDir()
	target := t.TempDir()
	content := []byte("完整原始正文\r\n")
	if err := os.Mkdir(filepath.Join(source, "tree"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "tree", "note.md"), content, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(target, "tree"), 0700); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("tree/note.md"))
	temp := ".folio-tmp-migrate-" + hex.EncodeToString(sum[:])
	if err := os.WriteFile(filepath.Join(target, "tree", temp), []byte("中断片段"), 0600); err != nil {
		t.Fatal(err)
	}
	src, err := os.OpenRoot(source)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	dst, err := os.OpenRoot(target)
	if err != nil {
		t.Fatal(err)
	}
	defer dst.Close()
	if err = copyVerified(src, "tree", dst, "tree"); err != nil {
		t.Fatal(err)
	}
	actual, err := os.ReadFile(filepath.Join(target, "tree", "note.md"))
	if err != nil || string(actual) != string(content) {
		t.Fatal(string(actual), err)
	}
	if _, err = os.Stat(filepath.Join(target, "tree", temp)); !os.IsNotExist(err) {
		t.Fatal("未清理已替换片段", err)
	}
}
