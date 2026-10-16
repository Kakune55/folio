package auth

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func passwordFixture(t *testing.T, password string) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "new-password")
	if err := os.WriteFile(file, []byte(password), 0o600); err != nil {
		t.Fatal(err)
	}
	return file
}

func TestOfflineResetRevokesSessionsAndKeepsWorkspaceIdentity(t *testing.T) {
	dir := privateTestDirectory(t)
	service, err := Open(dir, "原密码-1234567890")
	if err != nil {
		t.Fatal(err)
	}
	identity := service.WorkspaceID("same-root")
	originalHash := append([]byte(nil), service.hash...)
	token, _, err := service.Login("admin", "原密码-1234567890", "", "local")
	if err != nil {
		t.Fatal(err)
	}
	secret := passwordFixture(t, "新的密码-1234567890\r\n")
	if err = ResetPassword(dir, secret); err == nil {
		t.Fatal("运行实例未阻止离线重置")
	}
	if err = service.Close(); err != nil {
		t.Fatal(err)
	}
	// 非账号数据不属于重置范围，旧引导文件也不会冒充新密码文件。
	sentinel := filepath.Join(dir, "initial-password")
	if err = os.WriteFile(sentinel, []byte("原引导文件不更新"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err = ResetPassword(dir, secret); err != nil {
		t.Fatal(err)
	}
	service, err = Open(dir, "忽略新的初始化密码")
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	if service.WorkspaceID("same-root") != identity || bytes.Equal(service.hash, originalHash) {
		t.Fatal("重置未更新哈希，或改变了浏览器草稿工作区身份")
	}
	if _, err = service.Authenticate(token); err == nil {
		t.Fatal("旧会话仍可使用")
	}
	if _, _, err = service.Login("admin", "原密码-1234567890", "", "old"); err == nil {
		t.Fatal("旧密码仍可使用")
	}
	if _, _, err = service.Login("admin", "新的密码-1234567890", "", "new"); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(sentinel); err != nil || string(data) != "原引导文件不更新" {
		t.Fatal("重置修改了无关文件")
	}
}

func TestResetRefusesMissingAccountAndRollsBackPartialUpdate(t *testing.T) {
	secret := passwordFixture(t, "新密码-1234567890")
	dir := privateTestDirectory(t)
	if err := ResetPassword(dir, secret); err == nil {
		t.Fatal("不存在账号库却初始化了账号")
	}
	if _, err := os.Stat(filepath.Join(dir, "app.db")); !os.IsNotExist(err) {
		t.Fatal("无账号库的重置创建了数据库")
	}
	service, err := Open(dir, "原密码-1234567890")
	if err != nil {
		t.Fatal(err)
	}
	originalHash := append([]byte(nil), service.hash...)
	if _, err = service.db.Exec("DROP TABLE sessions"); err != nil {
		t.Fatal(err)
	}
	service.Close()
	if err = ResetPassword(dir, secret); err == nil {
		t.Fatal("会话表损坏未中止事务")
	}
	service, err = Open(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	if !bytes.Equal(service.hash, originalHash) {
		t.Fatal("撤销会话失败后密码却被修改")
	}
	if _, _, err = service.Login("admin", "原密码-1234567890", "", "local"); err != nil {
		t.Fatal("回滚后原密码不可用", err)
	}
}

func TestPrivateAccountFilesRejectLinksAndSpecialFiles(t *testing.T) {
	for _, name := range []string{"app.db", "instance.lock", "app.db-wal", "app.db-shm", "app.db-journal"} {
		for _, kind := range []string{"symlink", "hardlink", "fifo"} {
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
					err = unix.Mkfifo(filepath.Join(dir, name), 0o600)
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
	if _, err := ReadPasswordFile(secret); err == nil {
		t.Fatal("共享权限密码文件被接受")
	}
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkfifo(link, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadPasswordFile(link); err == nil {
		t.Fatal("管道密码文件被接受")
	}
}

func TestGeneratedPasswordAndPrivateDirectoryBoundary(t *testing.T) {
	dir := privateTestDirectory(t)
	service, err := Open(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	password, err := ReadPasswordFile(filepath.Join(dir, "initial-password"))
	if err != nil {
		service.Close()
		t.Fatal(err)
	}
	if _, _, err = service.Login("admin", password, "", "local"); err != nil {
		service.Close()
		t.Fatal(err)
	}
	service.Close()
	link := filepath.Join(t.TempDir(), "app-data-link")
	if err = os.Symlink(dir, link); err != nil {
		t.Fatal(err)
	}
	if service, err = Open(link, ""); err == nil {
		service.Close()
		t.Fatal("链接形式的私有根未拒绝")
	}
	if err = os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if service, err = Open(dir, ""); err == nil {
		service.Close()
		t.Fatal("共享目录权限未拒绝")
	}
}
