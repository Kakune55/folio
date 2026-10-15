package auth

import (
	"errors"
	"testing"
)

func TestSessionPersistenceRotationAndThrottling(t *testing.T) {
	dir := t.TempDir()
	password := "足够长的测试密码-987654"
	service, err := Open(dir, password)
	if err != nil {
		t.Fatal(err)
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
