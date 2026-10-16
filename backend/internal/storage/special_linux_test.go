package storage

import (
	"os"
	"path/filepath"
	"testing"
)

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
	if err := makeFIFO(filepath.Join(root, "fifo"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(secret, filepath.Join(root, "hardlink")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../secret.txt", "/etc/passwd", "escape/secret.txt", "a/../x", "a//x", "a\\x", "\x00", ".folio-tmp-forged", "C:note.md", "note.md:stream", "NUL", "COM1.txt", "note.", "note ", "dir/CON"} {
		_, err := s.Read(name)
		code(t, err, "path_invalid")
	}
	for _, name := range []string{"fifo"} {
		_, err := s.Read(name)
		code(t, err, "unsupported_file_type")
	}
	entries, _, err := s.List("", 0, 200)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name != "hardlink" {
		t.Fatalf("危险文件被列出：%+v", entries)
	}
}
