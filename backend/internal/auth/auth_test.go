package auth

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSessionPersistenceRotationAndThrottling(t *testing.T) {
	dir := privateTestDirectory(t)
	password := "足够长的测试密码-987654"
	service, err := Open(dir, password)
	if err != nil {
		t.Fatal(err)
	}
	workspaceID := service.WorkspaceID("root-identity-a")
	if workspaceID == service.WorkspaceID("root-identity-b") {
		t.Fatal("不同根目录复用了恢复命名空间")
	}
	token, _, err := service.Login("admin", password, "", "local")
	if err != nil {
		t.Fatal(err)
	}
	replacement, _, err := service.Login("admin", password, token, "local")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Authenticate(token); err == nil {
		t.Fatal("旧会话未撤销")
	}
	if err = service.Close(); err != nil {
		t.Fatal(err)
	}
	service, err = Open(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	if service.WorkspaceID("root-identity-a") != workspaceID {
		t.Fatal("重启后恢复命名空间发生变化")
	}
	if _, err = service.Authenticate(replacement); err != nil {
		t.Fatal("重启后会话丢失")
	}
	for i := 0; i < 5; i++ {
		_, _, err = service.Login("admin", "错误", "", "attacker")
		if !errors.Is(err, ErrCredentials) {
			t.Fatal(err)
		}
	}
	_, _, err = service.Login("admin", password, "", "attacker")
	if !errors.Is(err, ErrRateLimited) {
		t.Fatal("未限制登录尝试")
	}
}

func privateTestDirectory(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "app-data")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestBusyLoginDoesNotQueueOrConsumeAttempts(t *testing.T) {
	service, err := Open(privateTestDirectory(t), "并发登录测试-123456")
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	// 模拟一个仍在计算的密码校验，忙时请求不应加入等待队列或计入失败次数。
	service.loginMu.Lock()
	results := make(chan []error, 1)
	go func() {
		var resultsList []error
		for i := 0; i < 6; i++ {
			_, _, err := service.Login("admin", "并发登录测试-123456", "", "local")
			resultsList = append(resultsList, err)
		}
		results <- resultsList
	}()
	select {
	case resultsList := <-results:
		service.loginMu.Unlock()
		for _, err := range resultsList {
			if !errors.Is(err, ErrLoginBusy) {
				t.Fatal("在途登录未快速拒绝后续请求", err)
			}
		}
	case <-time.After(time.Second):
		service.loginMu.Unlock()
		<-results
		t.Fatal("在途登录导致后续请求排队")
	}
	if len(service.attempts) != 0 {
		t.Fatal("忙时请求消耗了密码错误次数")
	}
}
