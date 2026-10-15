//go:build linux

package storage

import (
	"context"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

type IndexEntry struct {
	Path, Stamp string
	Size        int64
}

func fileStamp(file *os.File) (string, int64, error) {
	var stat unix.Stat_t
	if err := unix.Fstat(int(file.Fd()), &stat); err != nil {
		return "", 0, err
	}
	return fmt.Sprintf("%d:%d:%d:%d:%d:%d:%d", stat.Dev, stat.Ino, stat.Size, stat.Mtim.Sec, stat.Mtim.Nsec, stat.Ctim.Sec, stat.Ctim.Nsec), stat.Size, nil
}

// Scan 不持有写锁，索引不能阻塞编辑；每次读取仍从根描述符安全解析。
func (s *Store) Scan(ctx context.Context, visit func(IndexEntry) error) error {
	var walk func(string) error
	walk = func(directory string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		name := directory
		if name == "" {
			name = "."
		}
		dir, err := s.open(name, unix.O_RDONLY|unix.O_DIRECTORY, 0)
		if err != nil {
			return err
		}
		entries, err := dir.ReadDir(-1)
		dir.Close()
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return err
			}
			relative := path.Join(directory, entry.Name())
			if ValidPath(relative, false) != nil || entry.Type()&os.ModeSymlink != 0 {
				continue
			}
			file, err := s.open(relative, unix.O_RDONLY, 0)
			if err != nil {
				// 不安全/不可读条目不进入索引；下一轮仍会重新检查。
				continue
			}
			info, err := file.Stat()
			if err != nil {
				file.Close()
				return err
			}
			if info.IsDir() {
				file.Close()
				if err = walk(relative); err != nil {
					return err
				}
				continue
			}
			stamp, size, err := fileStamp(file)
			file.Close()
			if err != nil {
				return err
			}
			if err = visit(IndexEntry{Path: relative, Stamp: stamp, Size: size}); err != nil {
				return err
			}
		}
		return nil
	}
	return walk("")
}
func (s *Store) ReadIndexText(name, expectedStamp string, limit int64) (string, error) {
	if err := ValidPath(name, false); err != nil {
		return "", err
	}
	file, err := s.open(name, unix.O_RDONLY, 0)
	if err != nil {
		return "", err
	}
	defer file.Close()
	info, err := regular(file)
	if err != nil {
		return "", err
	}
	if info.Size() > limit {
		return "", nil
	}
	before, _, err := fileStamp(file)
	if err != nil {
		return "", err
	}
	if before != expectedStamp {
		return "", fail("file_changed")
	}
	header := make([]byte, 512)
	n, headerErr := file.ReadAt(header, 0)
	if headerErr != nil && headerErr != io.EOF {
		return "", headerErr
	}
	if strings.EqualFold(path.Ext(name), ".pdf") || strings.HasPrefix(string(header[:n]), "%PDF-") || imageType(header[:n]) != "" {
		return "", nil
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return "", err
	}
	after, _, err := fileStamp(file)
	if err != nil {
		return "", err
	}
	if before != after {
		return "", fail("file_changed")
	}
	if int64(len(data)) > limit || !utf8.Valid(data) || strings.IndexByte(string(data), 0) >= 0 {
		return "", nil
	}
	return string(data), nil
}
