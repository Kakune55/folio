package storage

import (
	"context"
	"folio/internal/fileio"
	"folio/internal/trash"
	"os"
	"path/filepath"
	"testing"
)

func TestPrivateNamespaceAndUsage(t *testing.T) {
	s, root := testStore(t)
	for _, name := range []string{".folio", ".FOLIO/a.md", "x/.folio/a.md"} {
		code(t, ValidPath(name, false), "path_invalid")
		_, err := s.Read(name)
		code(t, err, "path_invalid")
		_, err = s.Write(name, "覆盖", "", true)
		code(t, err, "path_invalid")
		_, _, err = s.OpenDownload(name, false)
		code(t, err, "path_invalid")
	}
	for _, dir := range []string{".folio/trash", ".folio/shares", ".github"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	bin, err := trash.Open(filepath.Join(root, ".folio", "trash"))
	if err != nil {
		t.Fatal(err)
	}
	defer bin.Close()
	s.SetTrash(bin)
	internal, err := os.OpenRoot(filepath.Join(root, ".folio", "shares"))
	if err != nil {
		t.Fatal(err)
	}
	defer internal.Close()
	s.SetExtraUsage(func() (int64, error) { return fileio.TreeBytes(internal, ".", true) })
	if err = os.WriteFile(filepath.Join(root, ".folio/shares/snapshot.md"), []byte("1234567"), 0600); err != nil {
		t.Fatal(err)
	}
	rev, err := s.Write("note.md", "12345", "", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Write(".github/readme.md", "123", "", true); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Trash("note.md", rev); err != nil {
		t.Fatal(err)
	}
	usage, err := s.Usage()
	if err != nil || usage.Used != 15 {
		t.Fatal(usage, err)
	}
	details, err := s.StorageDetails(context.Background())
	if err != nil || details.Used != 15 {
		t.Fatal(details, err)
	}
	for _, c := range details.Categories {
		if c.Key == "trash" && c.Bytes != 5 || c.Key == "shares" && c.Bytes != 7 {
			t.Fatal(c)
		}
	}
	entries, _, err := s.List("", 0, 100)
	if err != nil || len(entries) != 1 || entries[0].Name != ".github" {
		t.Fatal(entries, err)
	}
	var scanned []string
	if err = s.Scan(context.Background(), func(e IndexEntry) error { scanned = append(scanned, e.Path); return nil }); err != nil || len(scanned) != 1 || scanned[0] != ".github/readme.md" {
		t.Fatal(scanned, err)
	}
	records, _, err := s.TrashList(0, 100)
	if err != nil || len(records) != 1 {
		t.Fatal(records, err)
	}
	if _, err = s.Restore(records[0].ID); err != nil {
		t.Fatal(err)
	}
}
