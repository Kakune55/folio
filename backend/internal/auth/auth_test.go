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

func TestPasswordEightByteMinimumAcrossEntryPoints(t *testing.T) {
	if _, err := Open(privateTestDirectory(t), "1234567"); err == nil {
		t.Fatal("首次初始化接受了七字节密码")
	}
	dir := privateTestDirectory(t)
	service, err := Open(dir, "12345678")
	if err != nil {
		t.Fatal("首次初始化拒绝了八字节密码", err)
	}
	defer service.Close()
	if _, _, err := service.Login("admin", "12345678", "", "local"); err != nil {
		t.Fatal("八字节初始密码无法登录", err)
	}
	input := UserInput{Username: "member", Enabled: true, Quota: 1 << 20, Password: "1234567"}
	if _, err := service.SaveUser(0, input); !errors.Is(err, ErrUserInput) {
		t.Fatal("创建用户接受七字节密码", err)
	}
	input.Password = "12345678"
	member, err := service.SaveUser(0, input)
	if err != nil {
		t.Fatal("创建用户拒绝八字节密码", err)
	}
	if err := service.ChangePassword(member.ID, "12345678", "1234567"); !errors.Is(err, ErrUserInput) {
		t.Fatal("自助改密接受七字节密码", err)
	}
	if err := service.ChangePassword(member.ID, "12345678", "abcdefg8"); err != nil {
		t.Fatal("自助改密拒绝八字节密码", err)
	}
	if _, _, err := service.Login("member", "abcdefg8", "", "changed"); err != nil {
		t.Fatal("改密后不能登录", err)
	}
	if err := service.ResetUserPassword(member.ID, "1234567"); !errors.Is(err, ErrUserInput) {
		t.Fatal("管理员重置接受七字节密码", err)
	}
	if err := service.ResetUserPassword(member.ID, "password"); err != nil {
		t.Fatal("管理员重置拒绝八字节密码", err)
	}
	if _, _, err := service.Login("member", "password", "", "reset"); err != nil {
		t.Fatal("重置后不能登录", err)
	}
	for _, candidate := range []struct {
		password string
		valid    bool
	}{{"1234567", false}, {"12345678", true}, {"密码ab", true}, {"密码a", false}} {
		file := passwordFixture(t, candidate.password+"\n")
		_, err := ReadPasswordFile(file)
		if (err == nil) != candidate.valid {
			t.Fatalf("密码文件 %q 有效性应为 %v：%v", candidate.password, candidate.valid, err)
		}
	}
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
