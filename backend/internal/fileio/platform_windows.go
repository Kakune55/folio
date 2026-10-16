package fileio

import (
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
)

// MoveFileEx 不设置 REPLACE_EXISTING，目标碰撞由系统拒绝。
// 父目录命名空间属于受信任的部署边界；不防御本机同用户恶意改名。
func renameNoReplace(from *os.Root, old string, to *os.Root, name string) error {
	a, err := windows.UTF16PtrFromString(filepath.Join(from.Name(), old))
	if err != nil {
		return err
	}
	b, err := windows.UTF16PtrFromString(filepath.Join(to.Name(), name))
	if err != nil {
		return err
	}
	return windows.MoveFileEx(a, b, windows.MOVEFILE_WRITE_THROUGH)
}
func Lock(file *os.File) error {
	return windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &windows.Overlapped{})
}
func Identity(root *os.Root) (string, error) {
	file, err := root.Open(".")
	if err != nil {
		return "", err
	}
	defer file.Close()
	var info windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(windows.Handle(file.Fd()), &info); err != nil {
		return "", err
	}
	return fmt.Sprintf("%d:%d:%d", info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow), nil
}
func CrossDevice(err error) bool { return errors.Is(err, windows.ERROR_NOT_SAME_DEVICE) }
