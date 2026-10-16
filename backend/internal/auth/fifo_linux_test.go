package auth

import (
	"golang.org/x/sys/unix"
	"os"
)

func makeFIFO(name string, mode os.FileMode) error { return unix.Mkfifo(name, uint32(mode)) }
