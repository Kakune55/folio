package layout

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReservedNameConflictsAndManagedDirectory(t *testing.T) {
	for _, name := range []string{".folio", ".FOLIO", "nested/.folio"} {
		t.Run(name, func(t *testing.T) {
			base := t.TempDir()
			if err := os.MkdirAll(filepath.Join(base, "1", name), 0700); err != nil {
				t.Fatal(err)
			}
			root, err := os.OpenRoot(base)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			if err = CheckNames(root); err == nil {
				t.Fatal("接管了保留名称冲突", name)
			}
		})
	}
	base := t.TempDir()
	root, err := os.OpenRoot(base)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if err = EnsureOwner(root, 1); err != nil {
		t.Fatal(err)
	}
	if err = EnsureOwner(root, 1); err != nil {
		t.Fatal(err)
	}
	if err = CheckNames(root); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(base, "1", ".folio", "layout"), []byte("损坏标记"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = EnsureOwner(root, 1); err == nil {
		t.Fatal("忽略损坏布局标记")
	}
}
