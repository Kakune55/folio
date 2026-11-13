package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"errors"

	"golang.org/x/crypto/argon2"
)

const DemoQuota int64 = 100 << 20
const DemoUsername = "folio"
const demoPassword = "folio"

var ErrDemoRestricted = errors.New("内置演示账号不允许修改账号、配额、启用状态或密码")

// IsDemoUser 识别已由 ConfigureDemo 校验的受控账号，关闭演示模式后仍保留保护。
func (s *Service) IsDemoUser(id int64) bool {
	return id > 0 && s.demoUserID.Load() == id
}

// ConfigureDemo 仅供启动调用，不支持运行时切换；正文初始化由调用方安全完成。
func (s *Service) ConfigureDemo(enabled bool) (user User, seeded bool, err error) {
	s.loginMu.Lock()
	defer s.loginMu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return user, false, err
	}
	defer tx.Rollback()
	var tables int
	if err = tx.QueryRow("SELECT count(*) FROM sqlite_schema WHERE name='demo_metadata'").Scan(&tables); err != nil {
		return user, false, err
	}
	if tables == 0 {
		if !enabled {
			return user, false, nil
		}
		if _, err = tx.Exec(`CREATE TABLE demo_metadata (
 id INTEGER PRIMARY KEY CHECK(id=1), user_id INTEGER NOT NULL UNIQUE,
 seeded INTEGER NOT NULL DEFAULT 0 CHECK(seeded IN (0,1)))`); err != nil {
			return user, false, err
		}
	}
	var count int
	if err = tx.QueryRow("SELECT count(*) FROM demo_metadata").Scan(&count); err != nil {
		return user, false, err
	}
	var salt, hash []byte
	if count == 0 {
		// 已有空表也不能据此收编同名真实账户。
		var conflicts int
		if err = tx.QueryRow("SELECT count(*) FROM account WHERE username=?", DemoUsername).Scan(&conflicts); err != nil {
			return user, false, err
		}
		if conflicts != 0 {
			return user, false, errors.New("演示账号名称已被真实账户占用，拒绝接管")
		}
		if !enabled {
			return user, false, nil
		}
		salt = make([]byte, 16)
		if _, err = rand.Read(salt); err != nil {
			return user, false, err
		}
		// 唯一允许短密码的内部固定种子，不经过普通账号输入入口。
		hash = argon2.IDKey([]byte(demoPassword), salt, 3, 64*1024, 1, 32)
		var result sql.Result
		result, err = tx.Exec("INSERT INTO account(username,enabled,admin,quota,salt,hash) VALUES(?,1,0,?,?,?)", DemoUsername, DemoQuota, salt, hash)
		if err != nil {
			return user, false, err
		}
		user.ID, err = result.LastInsertId()
		if err != nil {
			return user, false, err
		}
		if _, err = tx.Exec("INSERT INTO demo_metadata(id,user_id) VALUES(1,?)", user.ID); err != nil {
			return user, false, err
		}
	} else {
		if count != 1 {
			return user, false, errors.New("演示账号归属记录损坏，拒绝修改账户")
		}
		if err = tx.QueryRow(`SELECT a.id,a.username,a.admin,a.enabled,a.quota,a.salt,a.hash,m.seeded
 FROM demo_metadata m JOIN account a ON a.id=m.user_id WHERE m.id=1`).Scan(&user.ID, &user.Username, &user.Admin, &user.Enabled, &user.Quota, &salt, &hash, &seeded); err != nil {
			return user, false, err
		}
		if user.ID <= 1 || user.Username != DemoUsername || user.Admin || len(salt) != 16 || len(hash) != 32 {
			return User{}, false, errors.New("演示账号身份损坏，拒绝修改账户")
		}
		candidate := argon2.IDKey([]byte(demoPassword), salt, 3, 64*1024, 1, 32)
		if subtle.ConstantTimeCompare(candidate, hash) != 1 {
			return User{}, false, errors.New("演示账号密码校验失败，拒绝自动重置")
		}
	}
	if _, err = tx.Exec("UPDATE account SET enabled=?,quota=? WHERE id=?", enabled, DemoQuota, user.ID); err != nil {
		return user, seeded, err
	}
	if !enabled {
		if _, err = tx.Exec("DELETE FROM sessions WHERE user_id=?", user.ID); err != nil {
			return user, seeded, err
		}
		if _, err = tx.Exec("DELETE FROM access_tokens WHERE user_id=?", user.ID); err != nil {
			return user, seeded, err
		}
	}
	if err = tx.Commit(); err != nil {
		return user, seeded, err
	}
	s.demoUserID.Store(user.ID)
	user.Username, user.Admin, user.Enabled, user.Quota = DemoUsername, false, enabled, DemoQuota
	return user, seeded, nil
}

// MarkDemoSeeded 只在正文安全创建成功后调用，标记不随正文删除而清除。
func (s *Service) MarkDemoSeeded(userID int64) error {
	s.loginMu.Lock()
	defer s.loginMu.Unlock()
	if !s.IsDemoUser(userID) {
		return ErrDemoRestricted
	}
	result, err := s.db.Exec(`UPDATE demo_metadata SET seeded=1 WHERE id=1 AND user_id=?
 AND EXISTS(SELECT 1 FROM account WHERE id=? AND username=? COLLATE BINARY AND admin=0 AND id>1)`, userID, userID, DemoUsername)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err == nil && n != 1 {
		return ErrDemoRestricted
	}
	return err
}
