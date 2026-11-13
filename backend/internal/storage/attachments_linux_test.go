package storage

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestAttachmentUploadUnsafeTargets(t *testing.T) {
	store, root := testStore(t)
	outside := filepath.Join(t.TempDir(), "outside")
	old := []byte{0, 255, 1}
	if err := os.WriteFile(outside, old, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name  string
		setup func(string) error
		code  string
	}{
		{"dir", func(p string) error { return os.Mkdir(p, 0o755) }, "unsupported_file_type"},
		{"symlink", func(p string) error { return os.Symlink(outside, p) }, "path_invalid"},
		{"hardlink", func(p string) error { return os.Link(outside, p) }, "unsupported_file_type"},
		{"fifo", func(p string) error { return makeFIFO(p, 0o600) }, "unsupported_file_type"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.setup(filepath.Join(root, tc.name)); err != nil {
				t.Fatal(err)
			}
			_, _, err := store.UploadConditional("", tc.name, bytes.NewReader([]byte{0, 2}), false, digest(old), false)
			code(t, err, tc.code)
			_, err = store.Upload("", tc.name, bytes.NewReader(old), false)
			code(t, err, "target_exists")
		})
	}
	for _, name := range []string{"../outside", "/outside", "a/b", ".folio-tmp-test", "bad\\name"} {
		_, _, err := store.UploadConditional("", name, bytes.NewReader(old), false, "x", false)
		code(t, err, "path_invalid")
	}
	_, _, err := store.UploadConditional("../", "file", bytes.NewReader(old), false, "x", false)
	code(t, err, "path_invalid")
	if err := os.Symlink(filepath.Dir(outside), filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	_, _, err = store.UploadConditional("linked", "outside", bytes.NewReader(old), false, digest(old), false)
	code(t, err, "path_invalid")
	data, err := os.ReadFile(outside)
	if err != nil || !bytes.Equal(data, old) {
		t.Fatal("不安全目标操作改变了外部字节", err)
	}
}
