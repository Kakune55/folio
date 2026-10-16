package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"folio/internal/auth"
)

func TestPasswordResetCommandDoesNotStartServerOrInitializeWorkspace(t *testing.T) {
	base := t.TempDir()
	binary := filepath.Join(base, "folio")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if output, err := exec.CommandContext(ctx, "go", "build", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatalf("构建测试程序失败：%v %s", err, output)
	}
	dir := filepath.Join(base, "app-data")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(base, "reset-password")
	newPassword := "命令行重置测试-987654321"
	if err := os.WriteFile(secret, []byte(newPassword+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	service, err := auth.Open(dir, "原密码-1234567890")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if service != nil {
			service.Close()
		}
	}()
	token, _, err := service.Login("admin", "原密码-1234567890", "", "local")
	if err != nil {
		t.Fatal(err)
	}
	identity := service.WorkspaceID("root")
	workspace := filepath.Join(base, "never-created-workspace")
	run := func(ok bool, args ...string) {
		t.Helper()
		command := exec.CommandContext(ctx, binary, args...)
		for _, value := range os.Environ() {
			if !strings.HasPrefix(value, "FOLIO_") {
				command.Env = append(command.Env, value)
			}
		}
		// 无效服务配置不能影响离线命令，也不能造成新目录/账号初始化。
		command.Env = append(command.Env, "FOLIO_WORKSPACE="+workspace, "FOLIO_APP_DATA="+filepath.Join(base, "wrong-data"), "FOLIO_PASSWORD_FILE=/nonexistent/secret", "FOLIO_ADDR=invalid")
		output, err := command.CombinedOutput()
		if (err == nil) != ok {
			t.Fatalf("离线命令结果异常：%v %s", err, output)
		}
		if bytes.Contains(output, []byte(newPassword)) || bytes.Contains(output, []byte(token)) {
			t.Fatal("离线命令泄露密码或会话")
		}
	}
	args := []string{"-reset-password", "-app-data", dir, "-password-file", secret}
	run(false, args...)
	if err = service.Close(); err != nil {
		t.Fatal(err)
	}
	service = nil
	run(false, "-reset-password")
	run(false, "-password-file", secret)
	run(false, "-reset-password", "-healthcheck", "-app-data", dir, "-password-file", secret)
	run(true, args...)
	for _, path := range []string{workspace, filepath.Join(base, "wrong-data")} {
		if _, err = os.Stat(path); !os.IsNotExist(err) {
			t.Fatal("离线命令创建了服务数据目录")
		}
	}
	service, err = auth.Open(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if identity != service.WorkspaceID("root") {
		t.Fatal("重置改变了工作区身份")
	}
	if _, err = service.Authenticate(token); err == nil {
		t.Fatal("旧会话未撤销")
	}
	if _, _, err = service.Login("admin", newPassword, "", "local"); err != nil {
		t.Fatal(err)
	}
}
