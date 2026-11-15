package fileio

import (
	"os"
	"path"
	"strings"
)

// TreeBytes 只统计普通文件，不跟随链接；遇到异常条目明确失败。
// 普通保存/上传临时文件不计持久额度，故障隔离原件仍计入。
func TreeBytes(root *os.Root, name string, skipTemporary bool) (int64, error) {
	return treeBytes(root, name, skipTemporary, false)
}

// WorkspaceBytes 排除系统保留目录，内部载荷由专用仓库分别计费。
func WorkspaceBytes(root *os.Root) (int64, error) { return treeBytes(root, ".", true, true) }

func treeBytes(root *os.Root, name string, skipTemporary, workspace bool) (int64, error) {
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
		if workspace && strings.EqualFold(e.Name(), ".folio") {
			continue
		}
		if skipTemporary && strings.HasPrefix(e.Name(), ".folio-tmp-") && !strings.HasPrefix(e.Name(), ".folio-tmp-trash-") {
			continue
		}
		size, err := treeBytes(root, path.Join(name, e.Name()), skipTemporary, workspace)
		if err != nil {
			return 0, err
		}
		total += size
	}
	return total, nil
}
