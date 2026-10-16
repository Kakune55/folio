package auth

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAccountFilesRejectSymlinksAndSpecialFiles(t *testing.T) {
	for _, name := range []string{"app.db", "instance.lock", "app.db-wal", "app.db-shm", "app.db-journal"} {
		for _, kind := range []string{"symlink", "fifo"} {
			t.Run(name+"/"+kind, func(t *testing.T) {
				dir := privateTestDirectory(t)
				outside := passwordFixture(t, "外部文件原始内容")
				if name != "app.db" {
					if err := os.WriteFile(filepath.Join(dir, "app.db"), []byte("未打开的数据库"), 0o600); err != nil {
						t.Fatal(err)
					}
				}
				var err error
				switch kind {
				case "symlink":
					err = os.Symlink(outside, filepath.Join(dir, name))
				case "hardlink":
					err = os.Link(outside, filepath.Join(dir, name))
				case "fifo":
					err = makeFIFO(filepath.Join(dir, name), 0o600)
				}
				if err != nil {
					t.Fatal(err)
				}
				service, err := Open(dir, "不应初始化-123456")
				if err == nil {
					service.Close()
					t.Fatal("不安全账号文件未被拒绝")
				}
				if data, err := os.ReadFile(outside); err != nil || string(data) != "外部文件原始内容" {
					t.Fatal("外部文件被改动")
				}
			})
		}
	}
}

func TestPasswordFileIsBoundedPrivateAndUnlinked(t *testing.T) {
	for _, password := range []string{"短", strings.Repeat("a", 1025), "valid-password\nsecond-line", "valid-password\r", "valid-password\x00", "invalid-utf8-\xff"} {
		if _, err := ReadPasswordFile(passwordFixture(t, password)); err == nil {
			t.Fatal("无效密码文件被接受")
		}
	}
	secret := passwordFixture(t, strings.Repeat("a", 1024)+"\r\n")
	if password, err := ReadPasswordFile(secret); err != nil || len(password) != 1024 {
		t.Fatal("边界长度/CRLF 密码被拒绝", err)
	}
	link := filepath.Join(t.TempDir(), "linked")
	if err := os.Symlink(secret, link); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadPasswordFile(link); err == nil {
		t.Fatal("密码符号链接被接受")
	}
	if err := os.Chmod(secret, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadPasswordFile(secret); err != nil {
		t.Fatal("权限由部署管理，不应拒绝普通密码文件", err)
	}
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := makeFIFO(link, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadPasswordFile(link); err == nil {
		t.Fatal("管道密码文件被接受")
	}
}
