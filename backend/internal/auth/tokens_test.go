package auth

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestAccessTokenLifecycleAndSecrecy(t *testing.T) {
	dir := privateTestDirectory(t)
	s, err := Open(dir, "token-test-password-2026")
	if err != nil {
		t.Fatal(err)
	}
	permission := TokenPermissions{"read", "read", "none"}
	entry, secret, err := s.CreateAccessToken(1, "workspace-a", "归档脚本", time.Now().Add(time.Hour).Unix(), permission)
	if err != nil {
		t.Fatal(err)
	}
	var stored string
	if err = s.db.QueryRow("SELECT token_hash FROM access_tokens WHERE id=?", entry.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == secret || stored != tokenHash(secret) {
		t.Fatal("未使用摘要保存")
	}
	entries, err := s.AccessTokens(1)
	if err != nil || len(entries) != 1 {
		t.Fatal(entries, err)
	}
	data, _ := json.Marshal(entries)
	if strings.Contains(string(data), secret) || strings.Contains(string(data), stored) || strings.Contains(string(data), "workspace-a") {
		t.Fatal("列表泄露凭据")
	}
	p, access, err := s.AuthenticateAccessToken(secret)
	if err != nil || p.ID != 1 || p.Admin || p.CSRF != "" || access.Permissions != permission {
		t.Fatal(p, access, err)
	}
	if _, err = s.Authenticate(secret); !errors.Is(err, ErrCredentials) {
		t.Fatal("访问令牌可作为会话")
	}
	if err = s.TouchAccessToken(entry.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.DeleteAccessToken(2, entry.ID); err == nil {
		t.Fatal("跨账号删除成功")
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, _, err = s.AuthenticateAccessToken(secret); err != nil {
		t.Fatal("重启丢失令牌", err)
	}
	entries, _ = s.AccessTokens(1)
	if entries[0].LastUsedAt == 0 {
		t.Fatal("未记录使用时间")
	}
	if _, err = s.db.Exec("UPDATE access_tokens SET expires_at=? WHERE id=?", time.Now().Unix()-1, entry.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.AuthenticateAccessToken(secret); !errors.Is(err, ErrCredentials) {
		t.Fatal("过期令牌有效", err)
	}
	if err = s.DeleteAccessToken(1, entry.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.AuthenticateAccessToken(secret); !errors.Is(err, ErrCredentials) {
		t.Fatal("删除后仍有效")
	}
}
func TestAccessTokenValidationLimitsAndRevocation(t *testing.T) {
	s, err := Open(privateTestDirectory(t), "token-test-password-2026")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, perms := range []TokenPermissions{{"none", "none", "none"}, {"admin", "read", "none"}, {"read", "", "none"}} {
		if _, _, err = s.CreateAccessToken(1, "workspace", "test", 0, perms); !errors.Is(err, ErrTokenInput) {
			t.Fatal(err)
		}
	}
	read := TokenPermissions{"read", "none", "none"}
	for _, expiry := range []int64{-1, time.Now().Unix() - 1, time.Now().Add(400 * 24 * time.Hour).Unix()} {
		if _, _, err = s.CreateAccessToken(1, "workspace", "test", expiry, read); !errors.Is(err, ErrTokenInput) {
			t.Fatal(err)
		}
	}
	for _, name := range []string{" ", strings.Repeat("字", 81), "a\nb"} {
		if _, _, err = s.CreateAccessToken(1, "workspace", name, 0, read); !errors.Is(err, ErrTokenInput) {
			t.Fatal(err)
		}
	}
	for i := 0; i < 100; i++ {
		if _, _, err = s.CreateAccessToken(1, "workspace", "test", 0, read); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err = s.CreateAccessToken(1, "workspace", "test", 0, read); !errors.Is(err, ErrTokenLimit) {
		t.Fatal(err)
	}
	if err = s.ChangePassword(1, "token-test-password-2026", "new-token-password-2026"); err != nil {
		t.Fatal(err)
	}
	entries, _ := s.AccessTokens(1)
	if len(entries) != 0 {
		t.Fatal("改密未撤销")
	}
	u, err := s.SaveUser(0, UserInput{Username: "alice", Password: "user-token-password-2026", Quota: DefaultQuota, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	_, secret, err := s.CreateAccessToken(u.ID, "workspace", "test", 0, read)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.SaveUser(u.ID, UserInput{Username: u.Username, Quota: u.Quota, Enabled: false}); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.AuthenticateAccessToken(secret); !errors.Is(err, ErrCredentials) {
		t.Fatal("禁用未撤销")
	}
	if _, err = s.SaveUser(u.ID, UserInput{Username: u.Username, Quota: u.Quota, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.AuthenticateAccessToken(secret); !errors.Is(err, ErrCredentials) {
		t.Fatal("重新启用恢复旧令牌")
	}
	_, secret, err = s.CreateAccessToken(u.ID, "workspace", "test", 0, read)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.ResetUserPassword(u.ID, "reset-token-password-2026"); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.AuthenticateAccessToken(secret); !errors.Is(err, ErrCredentials) {
		t.Fatal("重置未撤销")
	}
}
