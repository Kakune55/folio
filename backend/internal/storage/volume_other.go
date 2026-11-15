//go:build !windows && !linux

package storage

import "errors"

func volumeSpace(path string) (uint64, uint64, error) {
	return 0, 0, errors.New("当前平台未支持磁盘容量读取")
}
