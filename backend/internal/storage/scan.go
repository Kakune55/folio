package storage

import (
	"context"
	"errors"
	"io"
	"os"
	"path"
	"strings"
	"unicode/utf8"

	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

type IndexEntry struct {
	Path, Stamp string
	Size        int64
}

// 小文本使用正文摘要，避免依赖平台 inode/ctime；大附件只比较元数据，防止索引核对读取完整大文件。
func fileStamp(file *os.File) (string, int64, error) {
	info, err := file.Stat()
	if err != nil {
		return "", 0, err
	}
	if info.Size() > TextLimit {
		return fmt.Sprintf("%d:%d:%o", info.Size(), info.ModTime().UnixNano(), info.Mode()), info.Size(), nil
	}
	sum := sha256.New()
	if _, err = io.Copy(sum, io.NewSectionReader(file, 0, info.Size()+1)); err != nil {
		return "", 0, err
	}
	if err = unchanged(file, info); err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(sum.Sum(nil)), info.Size(), nil
}

// Scan 不持有写锁，索引不能阻塞编辑；每次读取仍从根描述符安全解析。
func (s *Store) Scan(ctx context.Context, visit func(IndexEntry) error) error {
	return s.ScanPath(ctx, "", visit)
}

// ScanPath 只检查指定文件或子树；已删除或变成不安全条目的路径不再进入索引。
func (s *Store) ScanPath(ctx context.Context, target string, visit func(IndexEntry) error) error {
	if err := ValidPath(target, true); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if target != "" {
		file, err := s.open(target, os.O_RDONLY, 0)
		if err != nil {
			var problem *Error
			if errors.As(err, &problem) && (problem.Code == "not_found" || problem.Code == "path_invalid" || problem.Code == "unsupported_file_type") {
				return nil
			}
			return err
		}
		info, err := file.Stat()
		if err != nil {
			file.Close()
			return err
		}
		if !info.IsDir() {
			stamp, size, err := fileStamp(file)
			file.Close()
			if err != nil {
				return err
			}
			return visit(IndexEntry{Path: target, Stamp: stamp, Size: size})
		}
		file.Close()
	}
	var walk func(string) error
	walk = func(directory string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		name := directory
		if name == "" {
			name = "."
		}
		dir, err := s.open(name, os.O_RDONLY, 0)
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
			file, err := s.open(relative, os.O_RDONLY, 0)
			if err != nil {
				// 不安全/不可读条目不进入索引；下次路径通知或重建时重新检查。
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
	return walk(target)
}
func (s *Store) ReadIndexText(name, expectedStamp string, limit int64) (string, error) {
	if err := ValidPath(name, false); err != nil {
		return "", err
	}
	file, err := s.open(name, os.O_RDONLY, 0)
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

// IndexFileSize 仅安全读取普通文件元数据，不因状态查询重新读取正文或计算摘要。
func (s *Store) IndexFileSize(name string) (int64, error) {
	if err := ValidPath(name, false); err != nil {
		return 0, err
	}
	file, err := s.open(name, os.O_RDONLY, 0)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	info, err := regular(file)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}
