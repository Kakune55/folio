package auth

import (
	"database/sql"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

// Access Token 只保存随机凭据摘要，不能用于浏览器会话或管理其他凭据。
type TokenPermissions struct {
	Files  string `json:"files"`
	Search string `json:"search"`
	Trash  string `json:"trash"`
}
type AccessToken struct {
	ID          int64            `json:"id"`
	Name        string           `json:"name"`
	Prefix      string           `json:"prefix"`
	CreatedAt   int64            `json:"createdAt"`
	ExpiresAt   int64            `json:"expiresAt"`
	LastUsedAt  int64            `json:"lastUsedAt"`
	Permissions TokenPermissions `json:"permissions"`
	WorkspaceID string           `json:"-"`
}

var ErrTokenInput = errors.New("令牌名称须为 1–80 个字符，权限须为 none/read/write，且至少授予一项权限；有效期须在未来且不超过 366 天")
var ErrTokenLimit = errors.New("最多保留 100 个访问令牌，请先删除不再使用的令牌")

func (s *Service) initTokens() error {
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS access_tokens (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL, prefix TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 last_used_at INTEGER NOT NULL DEFAULT 0, files TEXT NOT NULL, search TEXT NOT NULL, trash TEXT NOT NULL,
 workspace_id TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS access_tokens_user ON access_tokens(user_id);`)
	return err
}
func (s *Service) CreateAccessToken(userID int64, workspaceID, name string, expiresAt int64, permissions TokenPermissions) (AccessToken, string, error) {
	name = strings.TrimSpace(name)
	now := time.Now().Unix()
	valid := func(v string) bool { return v == "none" || v == "read" || v == "write" }
	if !utf8.ValidString(name) || utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 80 || strings.ContainsAny(name, "\r\n\x00") || workspaceID == "" || !valid(permissions.Files) || !valid(permissions.Search) || !valid(permissions.Trash) || permissions == (TokenPermissions{"none", "none", "none"}) || (expiresAt != 0 && (expiresAt <= now || expiresAt > now+366*86400)) {
		return AccessToken{}, "", ErrTokenInput
	}
	random, err := randomToken()
	if err != nil {
		return AccessToken{}, "", err
	}
	secret := "folio_" + random
	tx, err := s.db.Begin()
	if err != nil {
		return AccessToken{}, "", err
	}
	defer tx.Rollback()
	var count int
	if err = tx.QueryRow("SELECT count(*) FROM access_tokens WHERE user_id=?", userID).Scan(&count); err != nil {
		return AccessToken{}, "", err
	}
	if count >= 100 {
		return AccessToken{}, "", ErrTokenLimit
	}
	result, err := tx.Exec(`INSERT INTO access_tokens(user_id,token_hash,name,prefix,created_at,expires_at,files,search,trash,workspace_id)
 SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM account WHERE id=? AND enabled=1)`, userID, tokenHash(secret), name, secret[:14], now, expiresAt, permissions.Files, permissions.Search, permissions.Trash, workspaceID, userID)
	if err != nil {
		return AccessToken{}, "", err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return AccessToken{}, "", err
	}
	if n != 1 {
		return AccessToken{}, "", ErrCredentials
	}
	id, err := result.LastInsertId()
	if err != nil {
		return AccessToken{}, "", err
	}
	if err = tx.Commit(); err != nil {
		return AccessToken{}, "", err
	}
	return AccessToken{ID: id, Name: name, Prefix: secret[:14], CreatedAt: now, ExpiresAt: expiresAt, Permissions: permissions, WorkspaceID: workspaceID}, secret, nil
}
func (s *Service) AccessTokens(userID int64) ([]AccessToken, error) {
	rows, err := s.db.Query("SELECT id,name,prefix,created_at,expires_at,last_used_at,files,search,trash FROM access_tokens WHERE user_id=? ORDER BY id DESC", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := []AccessToken{}
	for rows.Next() {
		var t AccessToken
		if err = rows.Scan(&t.ID, &t.Name, &t.Prefix, &t.CreatedAt, &t.ExpiresAt, &t.LastUsedAt, &t.Permissions.Files, &t.Permissions.Search, &t.Permissions.Trash); err != nil {
			return nil, err
		}
		entries = append(entries, t)
	}
	return entries, rows.Err()
}
func (s *Service) DeleteAccessToken(userID, id int64) error {
	result, err := s.db.Exec("DELETE FROM access_tokens WHERE user_id=? AND id=?", userID, id)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err == nil && n == 0 {
		return sql.ErrNoRows
	}
	return err
}
func (s *Service) AuthenticateAccessToken(secret string) (*Principal, *AccessToken, error) {
	if len(secret) != 70 || !strings.HasPrefix(secret, "folio_") {
		return nil, nil, ErrCredentials
	}
	var p Principal
	var t AccessToken
	now := time.Now().Unix()
	err := s.db.QueryRow(`SELECT a.id,a.username,t.id,t.workspace_id,t.files,t.search,t.trash FROM access_tokens t JOIN account a ON a.id=t.user_id
 WHERE t.token_hash=? AND a.enabled=1 AND (t.expires_at=0 OR t.expires_at>?)`, tokenHash(secret), now).Scan(&p.ID, &p.Username, &t.ID, &t.WorkspaceID, &t.Permissions.Files, &t.Permissions.Search, &t.Permissions.Trash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, ErrCredentials
	}
	if err != nil {
		return nil, nil, err
	}
	return &p, &t, nil
}

// 仅记录已获准请求，最多每分钟写一次；撤销仍在每次认证时查库。
func (s *Service) TouchAccessToken(id int64) error {
	now := time.Now().Unix()
	_, err := s.db.Exec("UPDATE access_tokens SET last_used_at=? WHERE id=? AND last_used_at<?", now, id, now-60)
	return err
}
