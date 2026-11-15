package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"folio/internal/fileio"
	"folio/internal/trash"
	"io"
	"os"
	"time"
)

// Workspace 是上层唯一的工作区访问边界，不暴露本地路径、文件描述符或权限位。
type Workspace interface {
	Identity() (string, error)
	Close() error
	SetLimits(Limits) error
	Limits() Limits
	SetQuota(func() (int64, error))
	SetIndexUsage(func() (int64, error))
	Read(string) (*Content, error)
	Write(string, string, string, bool) (string, error)
	List(string, int, int) ([]Entry, int, error)
	Mkdir(string) error
	EntryRevision(string) (*EntryRevision, error)
	Move(string, string, string) error
	Trash(string, string) (*trash.Record, error)
	TrashList(int, int) ([]trash.Record, int, error)
	Restore(string) (string, error)
	Purge(string) error
	Usage() (Usage, error)
	StorageDetails(context.Context) (StorageBreakdown, error)
	Metadata(string) (*Metadata, error)
	ReadDownload(string, bool, int64) (*Download, *Metadata, error)
	Upload(string, string, io.Reader, bool) (*Metadata, error)
	UploadConditional(string, string, io.Reader, bool, string, bool) (*Metadata, string, error)
	Patch(string, string, string, bool) (*PatchResult, error)
	Scan(context.Context, func(IndexEntry) error) error
	ScanPath(context.Context, string, func(IndexEntry) error) error
	ReadIndexText(string, string, int64) (string, error)
	IndexFileSize(string) (int64, error)
	ReadBundle([]BundleFile) ([]BundleFile, error)
	ImportBundle(string, []BundleFile) (string, error)
	PublishSnapshot(string, []BundleFile, func() error) error
	ReadSnapshot(string, []BundleFile) ([]BundleFile, error)
	RemoveSnapshot(string) error
	SnapshotUsage() (int64, error)
}

type ReadSeekAtCloser interface {
	io.Reader
	io.Seeker
	io.ReaderAt
	io.Closer
}
type Download struct {
	ReadSeekAtCloser
	Revision string
}

// ReadDownload 把句柄校验留在存储层；调用方只持有稳定的只读数据源。
func (s *Store) ReadDownload(name string, preview bool, maxBytes int64) (*Download, *Metadata, error) {
	f, m, err := s.OpenDownload(name, preview)
	if err != nil {
		return nil, nil, err
	}
	valid := false
	defer func() {
		if !valid {
			f.Close()
		}
	}()
	if err = fileio.CheckSingleLink(f); err != nil {
		return nil, nil, fail("unsupported_file_type")
	}
	before, err := f.Stat()
	if err != nil {
		return nil, nil, err
	}
	if before.Size() > maxBytes {
		return nil, nil, fail("too_large")
	}
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, maxBytes+1))
	if err != nil {
		return nil, nil, err
	}
	if n > maxBytes {
		return nil, nil, fail("too_large")
	}
	after, err := f.Stat()
	if err != nil {
		return nil, nil, err
	}
	if err = fileio.CheckSingleLink(f); err != nil {
		return nil, nil, fail("unsupported_file_type")
	}
	if !os.SameFile(before, after) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) || before.Mode() != after.Mode() || n != before.Size() || m.Size != n || m.Mtime != before.ModTime().UTC().Format(time.RFC3339Nano) {
		return nil, nil, fail("file_changed")
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return nil, nil, err
	}
	valid = true
	return &Download{f, "sha256:" + hex.EncodeToString(h.Sum(nil))}, m, nil
}
