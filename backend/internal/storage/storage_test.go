package storage

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"golang.org/x/sys/unix"
)

func testStore(t *testing.T) (*Store, string) {
	t.Helper()
	root := t.TempDir()
	store, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return store, root
}
func code(t *testing.T, err error, want string) {
	t.Helper()
	var problem *Error
	if !errors.As(err, &problem) || problem.Code != want {
		t.Fatalf("预期 %s，得到 %v", want, err)
	}
}
func TestContainmentAndSpecialFiles(t *testing.T) {
	s, root := testStore(t)
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secret, []byte("外部原文"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkfifo(filepath.Join(root, "fifo"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(secret, filepath.Join(root, "hardlink")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../secret.txt", "/etc/passwd", "escape/secret.txt", "a/../x", "a//x", "a\\x", "\x00", ".folio-tmp-forged"} {
		_, err := s.Read(name)
		code(t, err, "path_invalid")
	}
	for _, name := range []string{"fifo", "hardlink"} {
		_, err := s.Read(name)
		code(t, err, "unsupported_file_type")
	}
	entries, _, err := s.List("", 0, 200)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("危险文件被列出：%+v", entries)
	}
}
func TestConditionalAtomicWrites(t *testing.T) {
	s, root := testStore(t)
	rev, err := s.Write("中文.md", "# 原文\n", "", true)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Write("中文.md", "覆盖", "", true)
	code(t, err, "target_exists")
	_, err = s.Write("中文.md", "覆盖", "", false)
	code(t, err, "precondition_required")
	var wg sync.WaitGroup
	var mu sync.Mutex
	success, conflict := 0, 0
	for i := 0; i < 6; i++ {
		wg.Go(func() {
			_, err := s.Write("中文.md", "并发修改", rev, false)
			mu.Lock()
			defer mu.Unlock()
			if err == nil {
				success++
			} else {
				var p *Error
				if errors.As(err, &p) && p.Code == "revision_conflict" {
					conflict++
				} else {
					t.Error(err)
				}
			}
		})
	}
	wg.Wait()
	if success != 1 || conflict != 5 {
		t.Fatalf("并发写未串行：成功 %d，冲突 %d", success, conflict)
	}
	content, err := s.Read("中文.md")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "中文.md"), []byte("外部编辑"), 0o640); err != nil {
		t.Fatal(err)
	}
	_, err = s.Write("中文.md", "不能覆盖外部编辑", content.Revision, false)
	code(t, err, "revision_conflict")
	original, _ := os.ReadFile(filepath.Join(root, "中文.md"))
	if string(original) != "外部编辑" {
		t.Fatal("外部内容丢失")
	}
	files, _ := os.ReadDir(root)
	for _, f := range files {
		if strings.HasPrefix(f.Name(), ".folio-tmp-") {
			t.Fatal("失败后残留临时文件")
		}
	}
	_, err = s.Write("big.md", strings.Repeat("x", int(TextLimit+1)), "", true)
	code(t, err, "too_large")
}
func TestSymlinkSwapCannotEscape(t *testing.T) {
	s, root := testStore(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "note.md"), []byte("不可修改"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "dir"), 0o700); err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			default:
			}
			_ = os.Rename(filepath.Join(root, "dir"), filepath.Join(root, "held"))
			_ = os.Symlink(outside, filepath.Join(root, "dir"))
			_ = os.Remove(filepath.Join(root, "dir"))
			_ = os.Rename(filepath.Join(root, "held"), filepath.Join(root, "dir"))
		}
	}()
	for i := 0; i < 100; i++ {
		_, _ = s.Write("dir/note.md", "写入工作区", "", true)
		_, _ = s.Read("dir/note.md")
	}
	close(stop)
	<-done
	data, err := os.ReadFile(filepath.Join(outside, "note.md"))
	if err != nil || string(data) != "不可修改" {
		t.Fatalf("逃逸写入：%q %v", data, err)
	}
}

func TestPermissionFailurePreservesOriginal(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("需要普通用户权限语义，root 可绕过目录权限")
	}
	store, root := testStore(t)
	revision, err := store.Write("note.md", "原始完整正文\r\n", "", true)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(root, 0o500); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(root, 0o700)
	if _, err = store.Write("note.md", "不得部分改写", revision, false); !errors.Is(err, unix.EACCES) {
		t.Fatalf("未观察到真实目录权限失败：%v", err)
	}
	content, err := os.ReadFile(filepath.Join(root, "note.md"))
	if err != nil || string(content) != "原始完整正文\r\n" {
		t.Fatal("失败后原文件被改变", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 1 {
		t.Fatal("权限失败留下了额外文件", err)
	}
}
