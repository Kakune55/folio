package storage

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// 只在隔离的测试子进程中施加文件大小限制/终止，不修改宿主挂载或填满共享磁盘。
func TestAtomicSaveProcessFaults(t *testing.T) {
	const key = "FOLIO_ATOMIC_SAVE_TEST"
	old := bytes.Repeat([]byte("原始正文\n"), 4096)
	next := strings.Repeat("N", 4<<20)
	if mode := os.Getenv(key); mode != "" {
		store, err := Open(os.Getenv(key + "_ROOT"))
		if err != nil {
			t.Fatal(err)
		}
		defer store.Close()
		original, err := store.Read("note.md")
		if err != nil {
			t.Fatal(err)
		}
		if mode == "limit" {
			signal.Ignore(syscall.SIGXFSZ)
			if err = unix.Setrlimit(unix.RLIMIT_FSIZE, &unix.Rlimit{Cur: 1024, Max: 1024}); err != nil {
				t.Fatal(err)
			}
		}
		_, err = store.Write("note.md", next, original.Revision, false)
		if mode == "limit" {
			if !errors.Is(err, unix.EFBIG) {
				t.Fatalf("未触发实际部分写入错误：%v", err)
			}
			return
		}
		if err != nil {
			t.Fatal(err)
		}
		// 即使替换先于父进程的 KILL 完成，也只允许留下完整新版本。
		time.Sleep(15 * time.Second)
		t.Fatal("父进程未在观察到临时文件后终止子进程")
	}
	for _, mode := range []string{"limit", "kill"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, "note.md"), old, 0o640); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestAtomicSaveProcessFaults$")
			command.Env = append(os.Environ(), key+"="+mode, key+"_ROOT="+root)
			var output bytes.Buffer
			command.Stdout = &output
			command.Stderr = &output
			watch := -1
			if mode == "kill" {
				var err error
				watch, err = unix.InotifyInit1(unix.IN_CLOEXEC | unix.IN_NONBLOCK)
				if err != nil {
					t.Fatal(err)
				}
				defer unix.Close(watch)
				if _, err = unix.InotifyAddWatch(watch, root, unix.IN_CREATE); err != nil {
					t.Fatal(err)
				}
			}
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if command.ProcessState == nil {
					command.Process.Kill()
					command.Wait()
				}
			})
			if mode == "kill" {
				seen := false
				buffer := make([]byte, 4096)
				for !seen && ctx.Err() == nil {
					if _, err := unix.Poll([]unix.PollFd{{Fd: int32(watch), Events: unix.POLLIN}}, 100); err != nil && err != unix.EINTR {
						t.Fatal(err)
					}
					n, err := unix.Read(watch, buffer)
					if err == unix.EAGAIN || err == unix.EINTR {
						continue
					}
					if err != nil {
						t.Fatal(err)
					}
					for at := 0; at+16 <= n; {
						length := int(binary.NativeEndian.Uint32(buffer[at+12 : at+16]))
						if at+16+length > n {
							t.Fatal("inotify 事件不完整")
						}
						seen = seen || strings.HasPrefix(strings.TrimRight(string(buffer[at+16:at+16+length]), "\x00"), ".folio-tmp-")
						at += 16 + length
					}
				}
				if !seen {
					t.Fatal("未观察到真实临时保存文件，不能声称覆盖了保存中终止")
				}
				if err := command.Process.Kill(); err != nil {
					t.Fatal(err)
				}
			}
			err := command.Wait()
			if mode == "limit" && err != nil {
				t.Fatalf("部分写入测试失败：%v %s", err, output.String())
			}
			if mode == "kill" {
				var exit *exec.ExitError
				if !errors.As(err, &exit) || exit.Sys().(syscall.WaitStatus).Signal() != syscall.SIGKILL {
					t.Fatalf("子进程并非被 SIGKILL：%v %s", err, output.String())
				}
			}
			data, err := os.ReadFile(filepath.Join(root, "note.md"))
			if err != nil {
				t.Fatal(err)
			}
			if mode == "limit" && !bytes.Equal(data, old) {
				t.Fatal("部分写入失败却改变了原文件")
			}
			if !bytes.Equal(data, old) && string(data) != next {
				t.Fatal("终止后正文不是完整原版或完整新版")
			}
			if mode == "limit" {
				entries, err := os.ReadDir(root)
				if err != nil || len(entries) != 1 {
					t.Fatal("已处理的写入错误留下了临时文件", err)
				}
			}
		})
	}
}
