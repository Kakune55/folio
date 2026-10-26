package storage

import (
	"context"
	"folio/internal/fileio"
	"os"
	"path"
	"strings"
)

type StorageCategory struct {
	Key   string `json:"key"`
	Bytes int64  `json:"bytes"`
}
type StorageBreakdown struct {
	Usage
	Categories []StorageCategory `json:"categories"`
}

// StorageDetails 按扩展名分类，只读元数据，不解析或改写正文；不安全条目使整次统计失败。
func (s *Store) StorageDetails(ctx context.Context) (StorageBreakdown, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	values := map[string]int64{}
	var walk func(string) error
	walk = func(name string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		f, err := fileio.Open(s.root, name, os.O_RDONLY, 0)
		if err != nil {
			return err
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			key := "other"
			if strings.HasPrefix(path.Base(name), ".folio-tmp-trash-") {
				key = "other"
			} else {
				switch strings.ToLower(path.Ext(name)) {
				case ".md", ".markdown", ".txt", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".csv", ".rtf", ".odt":
					key = "documents"
				case ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif", ".heic", ".bmp", ".ico", ".tif", ".tiff":
					key = "images"
				case ".mp3", ".mp4", ".m4a", ".mov", ".wav", ".ogg", ".flac", ".webm", ".mkv", ".aac":
					key = "media"
				}
			}
			values[key] += info.Size()
			return nil
		}
		entries, err := f.ReadDir(-1)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".folio-tmp-") && !strings.HasPrefix(entry.Name(), ".folio-tmp-trash-") {
				continue
			}
			if err = walk(path.Join(name, entry.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk("."); err != nil {
		return StorageBreakdown{}, err
	}
	if s.trash != nil {
		n, err := s.trash.Usage()
		if err != nil {
			return StorageBreakdown{}, err
		}
		values["trash"] = n
	}
	if s.extraUsage != nil {
		n, err := s.extraUsage()
		if err != nil {
			return StorageBreakdown{}, err
		}
		values["shares"] = n
	}
	result := StorageBreakdown{Categories: []StorageCategory{}}
	if s.quota != nil {
		q, err := s.quota()
		if err != nil {
			return StorageBreakdown{}, err
		}
		result.Quota = q
	}
	for _, key := range []string{"documents", "images", "media", "other", "trash", "shares"} {
		result.Categories = append(result.Categories, StorageCategory{key, values[key]})
		result.Used += values[key]
	}
	return result, nil
}
