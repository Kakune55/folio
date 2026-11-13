package auth

import (
	"bytes"
	"errors"
	"testing"
)

func demoTestService(t *testing.T) (*Service, string) {
	t.Helper()
	dir := privateTestDirectory(t)
	s, err := Open(dir, "admin-password")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, dir
}

func demoCredentials(t *testing.T, s *Service, id int64) ([]byte, []byte) {
	t.Helper()
	var salt, hash []byte
	if err := s.db.QueryRow("SELECT salt,hash FROM account WHERE id=?", id).Scan(&salt, &hash); err != nil {
		t.Fatal(err)
	}
	return salt, hash
}

func TestDemoLifecycle(t *testing.T) {
	s, dir := demoTestService(t)
	if _, seeded, err := s.ConfigureDemo(false); err != nil || seeded {
		t.Fatalf("关闭未初始化的演示模式：%v %v", seeded, err)
	}
	var tables int
	if err := s.db.QueryRow("SELECT count(*) FROM sqlite_schema WHERE name='demo_metadata'").Scan(&tables); err != nil || tables != 0 {
		t.Fatalf("普通模式新增了演示表：%d %v", tables, err)
	}
	adminSalt, adminHash := demoCredentials(t, s, 1)
	u, seeded, err := s.ConfigureDemo(true)
	if err != nil || seeded || u.ID != 2 || u.Admin || !u.Enabled || u.Username != DemoUsername || u.Quota != 100<<20 || !s.IsDemoUser(u.ID) || s.IsDemoUser(0) || s.IsDemoUser(1) {
		t.Fatalf("演示初始化异常：%+v %v %v", u, seeded, err)
	}
	salt, hash := demoCredentials(t, s, u.ID)
	if len(salt) != 16 || len(hash) != 32 {
		t.Fatal("演示凭据未使用标准盐与哈希长度")
	}
	demoSession, principal, err := s.Login("folio", "folio", "", "demo")
	if err != nil || principal.Admin || principal.ID != u.ID {
		t.Fatalf("演示登录异常：%+v %v", principal, err)
	}
	if err = s.MarkDemoSeeded(1); !errors.Is(err, ErrDemoRestricted) {
		t.Fatalf("允许标记管理员：%v", err)
	}
	if err = s.MarkDemoSeeded(u.ID); err != nil {
		t.Fatal(err)
	}
	other, err := s.SaveUser(0, UserInput{Username: "other", Enabled: true, Quota: 1234, Password: "other-password"})
	if err != nil {
		t.Fatal(err)
	}
	otherSession, _, err := s.Login(other.Username, "other-password", "", "other")
	if err != nil {
		t.Fatal(err)
	}
	adminSession, _, err := s.Login("admin", "admin-password", "", "admin")
	if err != nil {
		t.Fatal(err)
	}
	permissions := TokenPermissions{Files: "write", Search: "read", Trash: "read"}
	_, demoToken, err := s.CreateAccessToken(u.ID, "demo-workspace", "演示", 0, permissions)
	if err != nil {
		t.Fatal(err)
	}
	_, otherToken, err := s.CreateAccessToken(other.ID, "other-workspace", "普通", 0, permissions)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.AuthenticateAccessToken(demoToken); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	u2, seeded, err := s.ConfigureDemo(true)
	if err != nil || !seeded || u2 != u {
		t.Fatalf("重启改变账户或丢失标记：%+v %v %v", u2, seeded, err)
	}
	nextSalt, nextHash := demoCredentials(t, s, u.ID)
	if !bytes.Equal(salt, nextSalt) || !bytes.Equal(hash, nextHash) {
		t.Fatal("重启重置了演示凭据")
	}
	if _, seeded, err = s.ConfigureDemo(false); err != nil || !seeded || !s.IsDemoUser(u.ID) {
		t.Fatalf("关闭丢失演示归属或种子标记：%v %v", seeded, err)
	}
	if _, _, err = s.Login("folio", "folio", "", "disabled"); !errors.Is(err, ErrCredentials) {
		t.Fatalf("关闭后仍能登录：%v", err)
	}
	if _, err = s.Authenticate(demoSession); !errors.Is(err, ErrCredentials) {
		t.Fatalf("演示会话未撤销：%v", err)
	}
	if _, _, err = s.AuthenticateAccessToken(demoToken); !errors.Is(err, ErrCredentials) {
		t.Fatalf("演示令牌未撤销：%v", err)
	}
	for _, token := range []string{adminSession, otherSession} {
		if _, err = s.Authenticate(token); err != nil {
			t.Fatalf("其他会话受影响：%v", err)
		}
	}
	if _, _, err = s.AuthenticateAccessToken(otherToken); err != nil {
		t.Fatalf("其他令牌受影响：%v", err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if disabled, seeded, err := s.ConfigureDemo(false); err != nil || !seeded || disabled.Enabled || !s.IsDemoUser(u.ID) {
		t.Fatalf("关闭后重启丢失状态：%+v %v %v", disabled, seeded, err)
	}
	if err = s.ResetUserPassword(u.ID, "new-password"); !errors.Is(err, ErrDemoRestricted) {
		t.Fatal("关闭模式重启后允许重置演示密码", err)
	}
	if _, seeded, err = s.ConfigureDemo(true); err != nil || !seeded {
		t.Fatalf("重开未保留标记：%v %v", seeded, err)
	}
	if _, err = s.Authenticate(demoSession); !errors.Is(err, ErrCredentials) {
		t.Fatal("重开复活旧会话", err)
	}
	if _, _, err = s.AuthenticateAccessToken(demoToken); !errors.Is(err, ErrCredentials) {
		t.Fatal("重开复活旧令牌", err)
	}
	if _, _, err = s.Login("folio", "folio", "", "reenabled"); err != nil {
		t.Fatal(err)
	}
	nextSalt, nextHash = demoCredentials(t, s, 1)
	if !bytes.Equal(adminSalt, nextSalt) || !bytes.Equal(adminHash, nextHash) {
		t.Fatal("演示模式改变管理员凭据")
	}
	if actual, err := s.User(other.ID); err != nil || actual != other {
		t.Fatalf("其他账户受影响：%+v %v", actual, err)
	}
}

func TestDemoRestrictionsAndNormalValidation(t *testing.T) {
	s, _ := demoTestService(t)
	u, _, err := s.ConfigureDemo(true)
	if err != nil {
		t.Fatal(err)
	}
	for _, input := range []UserInput{
		{Username: "renamed", Enabled: true, Quota: DemoQuota},
		{Username: DemoUsername, Enabled: true, Quota: DemoQuota + 1},
		{Username: DemoUsername, Enabled: false, Quota: DemoQuota},
		{Username: DemoUsername, Enabled: true, Quota: DemoQuota, Password: "new-password"},
	} {
		if _, err = s.SaveUser(u.ID, input); !errors.Is(err, ErrDemoRestricted) {
			t.Fatalf("允许修改受控账户：%+v %v", input, err)
		}
	}
	if err = s.ChangePassword(u.ID, demoPassword, "new-password"); !errors.Is(err, ErrDemoRestricted) {
		t.Fatal("允许自助改密", err)
	}
	if err = s.ResetUserPassword(u.ID, "new-password"); !errors.Is(err, ErrDemoRestricted) {
		t.Fatal("允许重置密码", err)
	}
	for _, quota := range []int64{-1, 1<<50 + 1} {
		if _, err = s.SaveUser(0, UserInput{Username: "normal", Enabled: true, Quota: quota, Password: "normal-password"}); !errors.Is(err, ErrUserInput) {
			t.Fatalf("普通账户配额校验被放宽：%v", err)
		}
	}
	if _, err = s.SaveUser(0, UserInput{Username: "normal", Enabled: true, Quota: DemoQuota, Password: "folio"}); !errors.Is(err, ErrUserInput) {
		t.Fatal("普通用户接受五字节密码", err)
	}
	if _, err = s.SaveUser(1, UserInput{Username: "admin", Enabled: true, Quota: DefaultQuota}); err != nil {
		t.Fatal("管理员修改受影响", err)
	}
	if err = s.ChangePassword(1, "admin-password", "next-password"); err != nil {
		t.Fatal(err)
	}
	if err = s.ResetUserPassword(1, "reset-password"); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.Login("admin", "reset-password", "", "reset"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec("UPDATE account SET enabled=0,quota=1 WHERE id=?", u.ID); err != nil {
		t.Fatal(err)
	}
	if restored, _, err := s.ConfigureDemo(true); err != nil || !restored.Enabled || restored.Quota != DemoQuota {
		t.Fatalf("重开未恢复固定配额和启用状态：%+v %v", restored, err)
	}
}

func TestDemoSameNameConflict(t *testing.T) {
	s, _ := demoTestService(t)
	u, err := s.SaveUser(0, UserInput{Username: "FoLiO", Enabled: true, Quota: 4321, Password: "real-password"})
	if err != nil {
		t.Fatal(err)
	}
	salt, hash := demoCredentials(t, s, u.ID)
	if _, _, err = s.ConfigureDemo(true); err == nil {
		t.Fatal("收编了同名真实账户")
	}
	if _, _, err = s.ConfigureDemo(false); err != nil {
		t.Fatal(err)
	}
	actual, err := s.User(u.ID)
	if err != nil || actual != u || s.IsDemoUser(u.ID) {
		t.Fatalf("真实账户已改变：%+v %v", actual, err)
	}
	nextSalt, nextHash := demoCredentials(t, s, u.ID)
	if !bytes.Equal(salt, nextSalt) || !bytes.Equal(hash, nextHash) {
		t.Fatal("真实凭据已改变")
	}
	if _, _, err = s.Login("folio", "real-password", "", "real"); err != nil {
		t.Fatal(err)
	}
}

func TestDemoRejectCorruptMetadataAndHash(t *testing.T) {
	for _, corruption := range []string{
		"UPDATE demo_metadata SET user_id=1",
		"UPDATE demo_metadata SET user_id=9999",
		"UPDATE demo_metadata SET user_id=(SELECT id FROM account WHERE username='real')",
		"UPDATE account SET admin=1 WHERE username='folio'",
		"UPDATE account SET username='renamed' WHERE username='folio'",
		"UPDATE account SET hash=zeroblob(32) WHERE username='folio'",
	} {
		t.Run(corruption, func(t *testing.T) {
			s, _ := demoTestService(t)
			if _, _, err := s.ConfigureDemo(true); err != nil {
				t.Fatal(err)
			}
			real, err := s.SaveUser(0, UserInput{Username: "real", Enabled: true, Quota: 1234, Password: "real-password"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.db.Exec(corruption); err != nil {
				t.Fatal(err)
			}
			for _, enabled := range []bool{false, true} {
				if _, _, err = s.ConfigureDemo(enabled); err == nil {
					t.Fatalf("损坏记录未拒绝，enabled=%v", enabled)
				}
			}
			if actual, err := s.User(real.ID); err != nil || actual != real {
				t.Fatalf("误改真实账户：%+v %v", actual, err)
			}
			if admin, err := s.User(1); err != nil || !admin.Enabled || !admin.Admin {
				t.Fatalf("误禁管理员：%+v %v", admin, err)
			}
		})
	}
}
