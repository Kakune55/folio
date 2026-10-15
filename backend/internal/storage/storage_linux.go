//go:build linux

package storage

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"

	"golang.org/x/sys/unix"
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
	root   *os.File
	mu     sync.Mutex
	limits Limits
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
	if name == "" || !utf8.ValidString(name) || strings.ContainsAny(name, "\x00\\") || strings.HasPrefix(name, "/") || len(name) > 4096 {
		return fail("path_invalid")
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." || strings.HasPrefix(part, ".folio-tmp-") {
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

func Open(root string) (*Store, error) {
	fd, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	store := &Store{root: os.NewFile(uintptr(fd), "workspace"), limits: DefaultLimits}
	// 不降级为有竞态的路径检查；旧内核不支持 openat2 时明确拒绝启动。
	probe, err := store.open(".", unix.O_RDONLY|unix.O_DIRECTORY, 0)
	if err != nil {
		store.Close()
		return nil, fmt.Errorf("工作区需要 Linux openat2 支持：%w", err)
	}
	probe.Close()
	return store, nil
}
func (s *Store) Close() error { return s.root.Close() }
func (s *Store) open(name string, flags int, mode uint32) (*os.File, error) {
	how := &unix.OpenHow{Flags: uint64(flags | unix.O_CLOEXEC | unix.O_NONBLOCK), Mode: uint64(mode), Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_XDEV}
	if flags&unix.O_DIRECTORY != 0 {
		fd, err := unix.Openat2(int(s.root.Fd()), name, how)
		if err != nil {
			return nil, mapError(err)
		}
		return os.NewFile(uintptr(fd), name), nil
	}
	// 先用 O_PATH 识别 inode 类型，避免在确认类型前真正打开设备或 FIFO。
	how.Flags = unix.O_PATH | unix.O_CLOEXEC
	fd, err := unix.Openat2(int(s.root.Fd()), name, how)
	if err != nil {
		return nil, mapError(err)
	}
	reference := os.NewFile(uintptr(fd), name)
	defer reference.Close()
	info, err := reference.Stat()
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		if _, err = regular(reference); err != nil {
			return nil, err
		}
	}
	// /proc/self/fd 指向已验证的 inode，不再按可被替换的用户路径重新打开。
	readable, err := unix.Open(fmt.Sprintf("/proc/self/fd/%d", fd), flags|unix.O_CLOEXEC|unix.O_NONBLOCK, mode)
	if err != nil {
		return nil, mapError(err)
	}
	return os.NewFile(uintptr(readable), name), nil
}
func mapError(err error) error {
	switch {
	case errors.Is(err, unix.ENOENT):
		return fail("not_found")
	case errors.Is(err, unix.EEXIST):
		return fail("target_exists")
	case errors.Is(err, unix.ELOOP), errors.Is(err, unix.EXDEV), errors.Is(err, unix.ENOTDIR), errors.Is(err, unix.ENAMETOOLONG):
		return fail("path_invalid")
	case errors.Is(err, unix.EACCES), errors.Is(err, unix.EPERM):
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
	var stat unix.Stat_t
	if err = unix.Fstat(int(file.Fd()), &stat); err != nil {
		return nil, err
	}
	if stat.Nlink != 1 {
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
	file, err := s.open(name, unix.O_RDONLY, 0)
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
	dir, err := s.open(dirName, unix.O_RDONLY|unix.O_DIRECTORY, 0)
	if err != nil {
		return nil, 0, err
	}
	defer dir.Close()
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
		file, openErr := s.open(child, unix.O_RDONLY, 0)
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
func (s *Store) parent(name string) (*os.File, string, error) {
	dir, base := path.Split(name)
	dir = strings.TrimSuffix(dir, "/")
	if dir == "" {
		dir = "."
	}
	file, err := s.open(dir, unix.O_RDONLY|unix.O_DIRECTORY, 0)
	return file, base, err
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
	if err = unix.Mkdirat(int(parent.Fd()), base, 0o755); err != nil {
		return mapError(err)
	}
	return parent.Sync()
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
	mode := uint32(0o644)
	if !create {
		current, err := s.open(name, unix.O_RDONLY, 0)
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
		mode = uint32(info.Mode().Perm())
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	temp := ".folio-tmp-" + hex.EncodeToString(random[:])
	fd, err := unix.Openat(int(parent.Fd()), temp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if err != nil {
		return "", err
	}
	file := os.NewFile(uintptr(fd), temp)
	defer func() { file.Close(); _ = unix.Unlinkat(int(parent.Fd()), temp, 0) }()
	if _, err = io.WriteString(file, source); err != nil {
		return "", err
	}
	if err = file.Chmod(os.FileMode(mode)); err != nil {
		return "", err
	}
	if err = file.Sync(); err != nil {
		return "", err
	}
	if err = file.Close(); err != nil {
		return "", err
	}
	// 落盘临时文件后，紧邻替换前重新检查当前内容；拒绝外部改动。
	if !create {
		current, err := s.open(name, unix.O_RDONLY, 0)
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
	a, errA := parent.Stat()
	b, errB := verified.Stat()
	verified.Close()
	if errA != nil || errB != nil || !os.SameFile(a, b) {
		return "", fail("file_changed")
	}
	flags := uint(0)
	if create {
		flags = unix.RENAME_NOREPLACE
	}
	if err = unix.Renameat2(int(parent.Fd()), temp, int(parent.Fd()), base, flags); err != nil {
		return "", mapError(err)
	}
	if err = parent.Sync(); err != nil {
		return "", fail("durability_uncertain")
	}
	return digest([]byte(source)), nil
}
