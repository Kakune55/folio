package search

import (
	"errors"
	"folio/internal/fileio"
	"os"
	"path/filepath"
)

// Usage 按文件当前长度计入索引和 SQLite 辅助文件，不取得索引锁，避免与存储回调互锁。
// WAL 检查点可能同时创建或移除辅助文件，统计是当前磁盘用量的近似快照。
func (i *Index) Usage() (int64, error) {
	root, err := os.OpenRoot(filepath.Dir(i.filename))
	if err != nil {
		return 0, err
	}
	defer root.Close()
	var total int64
	for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
		f, e := fileio.Open(root, filepath.Base(i.filename)+suffix, os.O_RDONLY, 0)
		if errors.Is(e, os.ErrNotExist) {
			continue
		}
		if e != nil {
			return 0, e
		}
		info, e := f.Stat()
		if e == nil {
			e = fileio.CheckSingleLink(f)
		}
		f.Close()
		if e != nil {
			return 0, e
		}
		if !info.Mode().IsRegular() {
			return 0, fileio.ErrUnsafe
		}
		total += info.Size()
	}
	return total, nil
}
