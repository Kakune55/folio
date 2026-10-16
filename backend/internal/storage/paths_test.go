package storage

import "testing"

func TestPortablePathNames(t *testing.T) {
	for _, name := range []string{"../secret", "/note.md", "C:note.md", "note.md:stream", "NUL", "COM1.txt", "note.", "note ", "dir/CON", "a\\b", "a//b", ".FOLIO-TMP-forged"} {
		code(t, ValidPath(name, false), "path_invalid")
	}
	for _, name := range []string{"目录/中文.md", "notes/concept.md", "COM10.txt", "配置.json"} {
		if err := ValidPath(name, false); err != nil {
			t.Fatalf("有效文件名被拒绝 %s: %v", name, err)
		}
	}
}
