package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"errors"
	"regexp"
	"strings"

	"golang.org/x/crypto/argon2"
)

const DefaultQuota int64 = 5 << 30

var ErrUserInput = errors.New("用户名须为 1–64 位字母、数字、下划线、点或短横线；密码须为 12–1024 字节；配额须为 0–1024 TB；管理员不能禁用")
var ErrUsername = errors.New("用户名已存在")
var usernamePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$`)

type User struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Admin    bool   `json:"admin"`
	Enabled  bool   `json:"enabled"`
	Quota    int64  `json:"quota"`
}
type UserInput struct {
	Username string `json:"username"`
	Enabled  bool   `json:"enabled"`
	Quota    int64  `json:"quota"`
	Password string `json:"password"`
}

func (s *Service) User(id int64) (User, error) {
	var u User
	err := s.db.QueryRow("SELECT id,username,admin,enabled,quota FROM account WHERE id=?", id).Scan(&u.ID, &u.Username, &u.Admin, &u.Enabled, &u.Quota)
	return u, err
}
func (s *Service) Users(q string, offset, limit int) ([]User, int, error) {
	var total int
	// instr 将查询当成字面文本，不赋予 SQL 通配符语义。
	if err := s.db.QueryRow("SELECT count(*) FROM account WHERE instr(lower(username),lower(?))>0", q).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.Query("SELECT id,username,admin,enabled,quota FROM account WHERE instr(lower(username),lower(?))>0 ORDER BY id LIMIT ? OFFSET ?", q, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	users := []User{}
	for rows.Next() {
		var u User
		if err = rows.Scan(&u.ID, &u.Username, &u.Admin, &u.Enabled, &u.Quota); err != nil {
			return nil, 0, err
		}
		users = append(users, u)
	}
	return users, total, rows.Err()
}
func (s *Service) SaveUser(id int64, input UserInput) (User, error) {
	if !usernamePattern.MatchString(input.Username) || input.Quota < 0 || input.Quota > 1<<50 || (input.Password != "" && (len(input.Password) < 12 || len(input.Password) > 1024)) || (id == 0 && input.Password == "") {
		return User{}, ErrUserInput
	}
	// 与登录及自助改密共用高成本哈希闸门，防止并发 Argon2 耗尽内存。
	if !s.loginMu.TryLock() {
		return User{}, ErrLoginBusy
	}
	defer s.loginMu.Unlock()
	var salt, hash []byte
	if id != 0 {
		u, err := s.User(id)
		if err != nil {
			return User{}, err
		}
		if u.Admin && !input.Enabled {
			return User{}, ErrUserInput
		}
	}
	if id == 0 {
		salt = make([]byte, 16)
		if _, err := rand.Read(salt); err != nil {
			return User{}, err
		}
		hash = argon2.IDKey([]byte(input.Password), salt, 3, 64*1024, 1, 32)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback()
	if id == 0 {
		var result sql.Result
		result, err = tx.Exec("INSERT INTO account(username,enabled,quota,salt,hash) VALUES(?,?,?,?,?)", input.Username, input.Enabled, input.Quota, salt, hash)
		if err == nil {
			id, err = result.LastInsertId()
		}
	} else {
		_, err = tx.Exec("UPDATE account SET username=?,enabled=?,quota=? WHERE id=?", input.Username, input.Enabled, input.Quota, id)
		// 用户初始化盐属于工作区身份；改密不改变它。
		if err == nil && input.Password != "" {
			var originalSalt []byte
			err = tx.QueryRow("SELECT salt FROM account WHERE id=?", id).Scan(&originalSalt)
			if err == nil {
				hash = argon2.IDKey([]byte(input.Password), originalSalt, 3, 64*1024, 1, 32)
				_, err = tx.Exec("UPDATE account SET hash=? WHERE id=?", hash, id)
			}
		}
		if err == nil && (!input.Enabled || input.Password != "") {
			_, err = tx.Exec("DELETE FROM sessions WHERE user_id=?", id)
			if err == nil {
				_, err = tx.Exec("DELETE FROM access_tokens WHERE user_id=?", id)
			}
		}
	}
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint") {
			return User{}, ErrUsername
		}
		return User{}, err
	}
	if err = tx.Commit(); err != nil {
		return User{}, err
	}
	return s.User(id)
}
func (s *Service) ChangePassword(id int64, oldPassword, newPassword string) error {
	return s.setPassword(id, &oldPassword, newPassword)
}
func (s *Service) ResetUserPassword(id int64, newPassword string) error {
	return s.setPassword(id, nil, newPassword)
}
func (s *Service) setPassword(id int64, oldPassword *string, newPassword string) error {
	if len(newPassword) < 12 || len(newPassword) > 1024 || (oldPassword != nil && len(*oldPassword) > 1024) {
		return ErrUserInput
	}
	if !s.loginMu.TryLock() {
		return ErrLoginBusy
	}
	defer s.loginMu.Unlock()
	var salt, hash []byte
	if err := s.db.QueryRow("SELECT salt,hash FROM account WHERE id=?", id).Scan(&salt, &hash); err != nil {
		return err
	}
	if oldPassword != nil {
		candidate := argon2.IDKey([]byte(*oldPassword), salt, 3, 64*1024, 1, 32)
		if subtle.ConstantTimeCompare(candidate, hash) != 1 {
			return ErrCredentials
		}
	}
	next := argon2.IDKey([]byte(newPassword), salt, 3, 64*1024, 1, 32)
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("UPDATE account SET hash=? WHERE id=?", next, id); err != nil {
		return err
	}
	if _, err = tx.Exec("DELETE FROM sessions WHERE user_id=?", id); err != nil {
		return err
	}
	if _, err = tx.Exec("DELETE FROM access_tokens WHERE user_id=?", id); err != nil {
		return err
	}
	return tx.Commit()
}
