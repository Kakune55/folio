package storage

import (
	"crypto/rand"
	"encoding/hex"
	"io"
	"os"
	"path"
	"strings"

	"folio/internal/fileio"
)

// BundleFile 保留真实字节；Revision 用于确认分享清单后拒绝陈旧文件。
type BundleFile struct {
	Path     string    `json:"path"`
	Revision string    `json:"revision"`
	Metadata *Metadata `json:"metadata,omitempty"`
	Data     []byte    `json:"-"`
}

const BundleLimit int64 = 128 << 20
const BundleFileLimit = 256

func (s *Store) ReadBundle(files []BundleFile) ([]BundleFile, error) {
	if len(files) == 0 || len(files) > BundleFileLimit {
		return nil, fail("too_large")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]BundleFile, 0, len(files))
	var total int64
	seen := map[string]bool{}
	for _, selected := range files {
		if ValidPath(selected.Path, false) != nil || seen[selected.Path] {
			return nil, fail("path_invalid")
		}
		seen[selected.Path] = true
		f, err := s.open(selected.Path, os.O_RDONLY, 0)
		if err != nil {
			return nil, err
		}
		before, statErr := f.Stat()
		if statErr != nil {
			f.Close()
			return nil, statErr
		}
		data, err := io.ReadAll(io.LimitReader(f, BundleLimit-total+1))
		if err != nil {
			f.Close()
			return nil, err
		}
		total += int64(len(data))
		if total > BundleLimit {
			f.Close()
			return nil, fail("too_large")
		}
		after, statErr := f.Stat()
		if statErr != nil || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
			f.Close()
			return nil, fail("file_changed")
		}
		if _, err = f.Seek(0, io.SeekStart); err != nil {
			f.Close()
			return nil, err
		}
		metadata, err := s.metadata(f, selected.Path, s.limits)
		f.Close()
		if err != nil {
			return nil, err
		}
		rev := digest(data)
		if selected.Revision != "" && rev != selected.Revision {
			return nil, fail("revision_conflict")
		}
		if metadata.Size != int64(len(data)) {
			return nil, fail("file_changed")
		}
		result = append(result, BundleFile{Path: selected.Path, Revision: rev, Metadata: metadata, Data: data})
	}
	return result, nil
}

func (s *Store) SetExtraUsage(get func() (int64, error)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.extraUsage = get
}

// CommitExtra 与所有工作区增长写共用配额锁；回调不得再调用本 Store。
func (s *Store) CommitExtra(size int64, commit func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkQuota(size); err != nil {
		return err
	}
	return commit()
}

// ImportBundle 在同一父目录准备全部文件，再以不覆盖重命名发布整个目录。
func (s *Store) ImportBundle(directory string, files []BundleFile) (string, error) {
	if ValidPath(directory, false) != nil || len(files) == 0 || len(files) > BundleFileLimit {
		return "", fail("path_invalid")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var total int64
	for _, f := range files {
		if ValidPath(f.Path, false) != nil {
			return "", fail("path_invalid")
		}
		size := int64(len(f.Data))
		limit := s.limits.Attachment
		if f.Metadata != nil {
			switch f.Metadata.Viewer {
			case "image":
				limit = min(limit, s.limits.Image)
			case "pdf":
				limit = min(limit, s.limits.PDF)
			case "markdown", "text":
				limit = min(limit, s.limits.Text)
			}
		}
		if size > limit {
			return "", fail("too_large")
		}
		total += size
	}
	if total > BundleLimit {
		return "", fail("too_large")
	}
	if err := s.checkQuota(total); err != nil {
		return "", err
	}
	parent, base, err := s.parent(directory)
	if err != nil {
		return "", err
	}
	defer parent.Close()
	var nonce [16]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return "", err
	}
	temp := ".folio-tmp-" + hex.EncodeToString(nonce[:])
	if err = parent.Mkdir(temp, 0700); err != nil {
		return "", err
	}
	defer parent.RemoveAll(temp)
	root, err := parent.OpenRoot(temp)
	if err != nil {
		return "", err
	}
	defer root.Close()
	for _, f := range files {
		dir := path.Dir(f.Path)
		if dir != "." {
			if err = root.MkdirAll(dir, 0755); err != nil {
				return "", err
			}
		}
		file, e := root.OpenFile(f.Path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if e != nil {
			return "", mapError(e)
		}
		_, e = file.Write(f.Data)
		if e == nil {
			e = fileio.Sync(file)
		}
		e = joinClose(e, file)
		if e != nil {
			return "", e
		}
	}
	if err = syncBundleDirs(root, "."); err != nil {
		return "", err
	}
	verified, _, err := s.parent(directory)
	if err != nil {
		return "", err
	}
	a, e1 := fileio.Stat(parent)
	b, e2 := fileio.Stat(verified)
	verified.Close()
	if e1 != nil || e2 != nil || !os.SameFile(a, b) {
		return "", fail("file_changed")
	}
	if err = fileio.Rename(parent, temp, parent, base); err != nil {
		return "", mapError(err)
	}
	if err = fileio.SyncRoot(parent); err != nil {
		return directory, fail("durability_uncertain")
	}
	return directory, nil
}
func joinClose(err error, file *os.File) error {
	e := file.Close()
	if err != nil {
		return err
	}
	return e
}
func syncBundleDirs(root *os.Root, name string) error {
	dir, err := fileio.Open(root, name, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	entries, err := dir.ReadDir(-1)
	dir.Close()
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() {
			if err = syncBundleDirs(root, path.Join(name, e.Name())); err != nil {
				return err
			}
		}
	}
	sub, err := root.OpenRoot(name)
	if err != nil {
		return err
	}
	defer sub.Close()
	return fileio.SyncRoot(sub)
}

// BundleDestination 将绝对工作区链接改为副本包中的相对路径时使用。
func BundleDestination(from, to string) string {
	a := strings.Split(path.Dir(from), "/")
	if path.Dir(from) == "." {
		a = nil
	}
	b := strings.Split(to, "/")
	for len(a) > 0 && len(b) > 0 && a[0] == b[0] {
		a = a[1:]
		b = b[1:]
	}
	return strings.Repeat("../", len(a)) + "./" + strings.Join(b, "/")
}
