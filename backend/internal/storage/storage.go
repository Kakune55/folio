package storage

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"folio/internal/trash"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"

	"folio/internal/fileio"
)

const TextLimit int64 = 5 << 20

// Error 只暴露稳定错误码，文件系统的绝对路径不得进入 API 响应。
type Error struct {
	Code     string
	Revision string
}

func (e *Error) Error() string { return e.Code }
func fail(code string) error   { return &Error{Code: code} }

type Store struct {
	extraUsage func() (int64, error)
	quota      func() (int64, error)
	root       *os.Root
	mu         sync.Mutex
	limits     Limits
	trash      *trash.Repository
	uploads    map[string]int
}
type Entry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Kind string `json:"kind"`
	Size int64  `json:"size"`
}
type Content struct {
	Path     string `json:"path"`
	Kind     string `json:"kind"`
	Content  string `json:"content"`
	Encoding string `json:"encoding"`
	Revision string `json:"revision"`
	Size     int64  `json:"size"`
	Mtime    string `json:"mtime"`
}

func ValidPath(name string, allowRoot bool) error {
	if allowRoot && name == "" {
		return nil
	}
	if name == "" || !utf8.ValidString(name) || strings.ContainsAny(name, "\x00\\:\"<>|?*") || strings.HasPrefix(name, "/") || len(name) > 4096 {
		return fail("path_invalid")
	}
	for _, part := range strings.Split(name, "/") {
		if strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") || reservedName(part) || part == "" || part == "." || part == ".." || strings.HasPrefix(strings.ToLower(part), ".folio-tmp-") {
			return fail("path_invalid")
		}
		for _, r := range part {
			if r < 32 || r == 127 {
				return fail("path_invalid")
			}
		}
	}
	return nil
}

// 统一拒绝 Windows 设备名与尾部别名，避免同一路径存在多种 API 身份。
func reservedName(part string) bool {
	base := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || base == "CONIN$" || base == "CONOUT$" {
		return true
	}
	return len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '1' && base[3] <= '9'
}

func Open(directory string) (*Store, error) {
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(absolute)
	if err != nil {
		return nil, err
	}
	return &Store{root: root, limits: DefaultLimits, uploads: make(map[string]int)}, nil
}

// Identity 仅用于浏览器恢复命名空间，保留已有 Linux 工作区身份。
func (s *Store) Identity() (string, error) { return fileio.Identity(s.root) }
func (s *Store) Close() error              { return s.root.Close() }
func (s *Store) open(name string, flags int, mode uint32) (*os.File, error) {
	file, err := fileio.Open(s.root, name, flags, os.FileMode(mode))
	return file, mapError(err)
}
func mapError(err error) error {
	switch {
	case errors.Is(err, os.ErrNotExist):
		return fail("not_found")
	case errors.Is(err, os.ErrExist):
		return fail("target_exists")
	case errors.Is(err, fileio.ErrLink):
		return fail("path_invalid")
	case errors.Is(err, fileio.ErrUnsafe):
		return fail("unsupported_file_type")
	case errors.Is(err, os.ErrPermission):
		return fail("forbidden")
	default:
		return err
	}
}
func regular(file *os.File) (os.FileInfo, error) {
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fail("unsupported_file_type")
	}
	return info, nil
}
func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}
func read(file *os.File, textLimit int64) ([]byte, os.FileInfo, error) {
	info, err := regular(file)
	if err != nil {
		return nil, nil, err
	}
	if info.Size() > textLimit {
		return nil, nil, fail("too_large")
	}
	data, err := io.ReadAll(io.LimitReader(file, textLimit+1))
	if err != nil {
		return nil, nil, err
	}
	if int64(len(data)) > textLimit {
		return nil, nil, fail("too_large")
	}
	if !utf8.Valid(data) || strings.IndexByte(string(data), 0) >= 0 {
		return nil, nil, fail("unsupported_file_type")
	}
	after, err := file.Stat()
	if err != nil {
		return nil, nil, err
	}
	if info.Size() != after.Size() || !info.ModTime().Equal(after.ModTime()) {
		return nil, nil, fail("file_changed")
	}
	return data, info, nil
}
func (s *Store) Read(name string) (*Content, error) {
	if err := ValidPath(name, false); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := s.open(name, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, info, err := read(file, s.limits.Text)
	if err != nil {
		return nil, err
	}
	return &Content{Path: name, Kind: "text", Content: string(data), Encoding: "utf-8", Revision: digest(data), Size: info.Size(), Mtime: info.ModTime().UTC().Format("2006-01-02T15:04:05.999999999Z07:00")}, nil
}
func (s *Store) List(name string, offset, limit int) ([]Entry, int, error) {
	if err := ValidPath(name, true); err != nil {
		return nil, 0, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	dirName := name
	if dirName == "" {
		dirName = "."
	}
	dir, err := s.open(dirName, os.O_RDONLY, 0)
	if err != nil {
		return nil, 0, err
	}
	defer dir.Close()
	info, err := dir.Stat()
	if err != nil {
		return nil, 0, err
	}
	if !info.IsDir() {
		return nil, 0, fail("not_a_directory")
	}
	entries, err := dir.ReadDir(-1)
	if err != nil {
		return nil, 0, err
	}
	output := make([]Entry, 0, len(entries))
	for _, entry := range entries {
		child := path.Join(name, entry.Name())
		if ValidPath(child, false) != nil || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		file, openErr := s.open(child, os.O_RDONLY, 0)
		if openErr != nil {
			continue
		}
		info, statErr := file.Stat()
		if statErr != nil {
			file.Close()
			continue
		}
		kind := "file"
		if info.IsDir() {
			kind = "directory"
		} else if _, statErr = regular(file); statErr != nil {
			file.Close()
			continue
		}
		file.Close()
		output = append(output, Entry{Name: entry.Name(), Path: child, Kind: kind, Size: info.Size()})
	}
	sort.Slice(output, func(i, j int) bool {
		if output[i].Kind != output[j].Kind {
			return output[i].Kind == "directory"
		}
		return output[i].Name < output[j].Name
	})
	total := len(output)
	if offset > total {
		offset = total
	}
	end := min(offset+limit, total)
	return output[offset:end], total, nil
}
func (s *Store) parent(name string) (*os.Root, string, error) {
	dir, base := path.Split(name)
	dir = strings.TrimSuffix(dir, "/")
	if dir == "" {
		dir = "."
	}
	checked, err := s.open(dir, os.O_RDONLY, 0)
	if err != nil {
		return nil, "", err
	}
	defer checked.Close()
	root, err := s.root.OpenRoot(dir)
	if err != nil {
		return nil, "", mapError(err)
	}
	a, errA := checked.Stat()
	b, errB := root.Stat(".")
	if errA != nil || errB != nil || !os.SameFile(a, b) {
		root.Close()
		return nil, "", fail("file_changed")
	}
	return root, base, nil
}
func (s *Store) Mkdir(name string) error {
	if err := ValidPath(name, false); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	parent, base, err := s.parent(name)
	if err != nil {
		return err
	}
	defer parent.Close()
	if err = parent.Mkdir(base, 0o755); err != nil {
		return mapError(err)
	}
	return fileio.SyncRoot(parent)
}
func (s *Store) Write(name string, source string, revision string, create bool) (string, error) {
	if err := ValidPath(name, false); err != nil {
		return "", err
	}
	if !utf8.ValidString(source) || strings.IndexByte(source, 0) >= 0 {
		return "", fail("unsupported_file_type")
	}
	if !create && revision == "" {
		return "", fail("precondition_required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if int64(len(source)) > s.limits.Text {
		return "", fail("too_large")
	}
	parent, base, err := s.parent(name)
	if err != nil {
		return "", err
	}
	defer parent.Close()
	oldSize := int64(0)
	mode := uint32(0o644)
	if !create {
		current, err := s.open(name, os.O_RDONLY, 0)
		if err != nil {
			return "", err
		}
		data, info, err := read(current, s.limits.Text)
		current.Close()
		if err != nil {
			return "", err
		}
		if digest(data) != revision {
			return "", &Error{Code: "revision_conflict", Revision: digest(data)}
		}
		oldSize = info.Size()
		mode = uint32(info.Mode().Perm())
	}
	if err := s.checkQuota(int64(len(source)) - oldSize); err != nil {
		return "", err
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	temp := ".folio-tmp-" + hex.EncodeToString(random[:])
	file, err := parent.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", err
	}
	defer func() { file.Close(); _ = parent.Remove(temp) }()
	if _, err = io.WriteString(file, source); err != nil {
		return "", err
	}
	if err = file.Chmod(os.FileMode(mode)); err != nil {
		return "", err
	}
	if err = fileio.Sync(file); err != nil {
		return "", err
	}
	if err = file.Close(); err != nil {
		return "", err
	}
	// 落盘临时文件后，紧邻替换前重新检查当前内容；拒绝外部改动。
	if !create {
		current, err := s.open(name, os.O_RDONLY, 0)
		if err != nil {
			return "", err
		}
		data, _, err := read(current, s.limits.Text)
		current.Close()
		if err != nil {
			return "", err
		}
		if digest(data) != revision {
			return "", &Error{Code: "revision_conflict", Revision: digest(data)}
		}
	}
	// 再次通过根目录解析父路径，拒绝临时写入期间发生的父目录替换。
	verified, _, err := s.parent(name)
	if err != nil {
		return "", err
	}
	a, errA := fileio.Stat(parent)
	b, errB := fileio.Stat(verified)
	verified.Close()
	if errA != nil || errB != nil || !os.SameFile(a, b) {
		return "", fail("file_changed")
	}
	if create {
		err = fileio.Rename(parent, temp, parent, base)
	} else {
		err = parent.Rename(temp, base)
	}
	if err != nil {
		return "", mapError(err)
	}
	if err = fileio.SyncRoot(parent); err != nil {
		return "", fail("durability_uncertain")
	}
	return digest([]byte(source)), nil
}
