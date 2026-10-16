package fileio

import (
	"os"
	"path"
	"strings"
)

// TreeBytes 只统计普通文件，不跟随链接；遇到异常条目明确失败。
// 普通保存/上传临时文件不计持久额度，故障隔离原件仍计入。
func TreeBytes(root *os.Root, name string, skipTemporary bool) (int64, error) {
	f, err := Open(root, name, os.O_RDONLY, 0)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return 0, err
	}
	if info.Mode().IsRegular() {
		return info.Size(), nil
	}
	entries, err := f.ReadDir(-1)
	if err != nil {
		return 0, err
	}
	var total int64
	for _, e := range entries {
		if skipTemporary && strings.HasPrefix(e.Name(), ".folio-tmp-") && !strings.HasPrefix(e.Name(), ".folio-tmp-trash-") {
			continue
		}
		size, err := TreeBytes(root, path.Join(name, e.Name()), skipTemporary)
		if err != nil {
			return 0, err
		}
		total += size
	}
	return total, nil
}
