package auth

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"testing"
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
	_, access, err := service.CreateAccessToken(1, identity, "离线撤销", 0, TokenPermissions{"read", "none", "none"})
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
	if _, _, err = service.AuthenticateAccessToken(access); err == nil {
		t.Fatal("离线重置未撤销访问令牌")
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
	t.Run("链接根", func(t *testing.T) {
		if err := os.Symlink(dir, link); err != nil {
			if runtime.GOOS == "windows" {
				t.Skipf("当前 Windows 无符号链接权限：%v", err)
			}
			t.Fatal(err)
		}
		if service, err := Open(link, ""); err == nil {
			service.Close()
			t.Fatal("链接形式的私有根未拒绝")
		}
	})
	if err = os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if service, err = Open(dir, ""); err != nil {
		t.Fatal("目录权限由部署管理，不应拒绝启动", err)
	} else {
		service.Close()
	}
}
