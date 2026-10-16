package httpapi

import "golang.org/x/sys/windows"

func volumeSpace(path string) (uint64, uint64, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, 0, err
	}
	var available, total, free uint64
	err = windows.GetDiskFreeSpaceEx(name, &available, &total, &free)
	return total, available, err
}
