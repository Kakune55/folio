package storage

import (
	"errors"
	"folio/internal/fileio"
	"folio/internal/layout"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// OpenManaged 创建本地受管用户工作区，内部载荷与正文使用同一存储锁。
func OpenManaged(directory string, id int64) (*Store, error) {
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	if err = layout.EnsureOwner(root, id); err != nil {
		return nil, err
	}
	s, err := Open(filepath.Join(directory, strings.Split(layout.OwnerDir(id), "/")[0]))
	if err != nil {
		return nil, err
	}
	s.managed = true
	return s, nil
}
func snapshotName(name string) error {
	if ValidPath(name, false) != nil || strings.Contains(name, "/") {
		return fail("path_invalid")
	}
	return nil
}
func (s *Store) PublishSnapshot(name string, files []BundleFile, commit func() error) error {
	if err := snapshotName(name); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, selected := range files {
		if ValidPath(selected.Path, false) != nil {
			return fail("path_invalid")
		}
		f, e := s.open(selected.Path, os.O_RDONLY, 0)
		if e != nil {
			return e
		}
		data, e := io.ReadAll(io.LimitReader(f, BundleLimit+1))
		f.Close()
		if e != nil {
			return e
		}
		if selected.Revision == "" || digest(data) != selected.Revision || digest(selected.Data) != selected.Revision {
			return fail("revision_conflict")
		}
	}
	var n int64
	for _, f := range files {
		n += int64(len(f.Data))
	}
	if n > BundleLimit || len(files) > BundleFileLimit || len(files) == 0 {
		return fail("too_large")
	}
	if err := s.checkQuota(n); err != nil {
		return err
	}
	parent, err := Open(filepath.Join(s.root.Name(), ".folio", "shares"))
	if err != nil {
		return err
	}
	defer parent.Close()
	parent.limits = s.limits
	if _, err = parent.ImportBundle(name, files); err != nil {
		return err
	}
	// 数据库提交结果不明时保留载荷，避免删除可能已发布的快照。
	return commit()
}
func (s *Store) ReadSnapshot(name string, files []BundleFile) ([]BundleFile, error) {
	if err := snapshotName(name); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	checked, err := fileio.Open(s.root, ".folio/shares/"+name, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	checked.Close()
	source, err := Open(filepath.Join(s.root.Name(), ".folio", "shares", name))
	if err != nil {
		return nil, err
	}
	defer source.Close()
	source.limits = s.limits
	return source.ReadBundle(files)
}
func (s *Store) RemoveSnapshot(name string) error {
	if err := snapshotName(name); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	checked, err := fileio.Open(s.root, ".folio/shares", os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	checked.Close()
	dir, err := s.root.OpenRoot(".folio/shares")
	if err != nil {
		return err
	}
	defer dir.Close()
	if err = dir.RemoveAll(name); err != nil {
		return err
	}
	return fileio.SyncRoot(dir)
}
func (s *Store) snapshotUsageLocked() (int64, error) {
	n, err := fileio.TreeBytes(s.root, ".folio/shares", true)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	return n, err
}
func (s *Store) SnapshotUsage() (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snapshotUsageLocked()
}
