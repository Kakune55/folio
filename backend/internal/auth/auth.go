package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"
	"golang.org/x/sys/unix"
	_ "modernc.org/sqlite"
)

const SessionLifetime = 7 * 24 * time.Hour

type Principal struct {
	Username string `json:"username"`
	CSRF     string `json:"csrfToken"`
}
type attempt struct {
	count int
	until time.Time
}
type Service struct {
	db         *sql.DB
	lock       *os.File
	salt, hash []byte
	mu         sync.Mutex
	attempts   map[string]attempt
	loginMu    sync.Mutex
}

var ErrCredentials = errors.New("账号或密码错误")
var ErrRateLimited = errors.New("尝试次数过多，请稍后重试")

func Open(dir, initialPassword string) (*Service, error) {
	lock, err := os.OpenFile(filepath.Join(dir, "instance.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err = unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		lock.Close()
		return nil, errors.New("此应用数据目录已有运行中的实例")
	}
	path := filepath.Join(dir, "app.db")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		lock.Close()
		return nil, err
	}
	f.Close()
	if err = os.Chmod(path, 0o600); err != nil {
		lock.Close()
		return nil, err
	}
	uri := (&url.URL{Scheme: "file", Path: path}).String() + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)"
	db, err := sql.Open("sqlite", uri)
	if err != nil {
		lock.Close()
		return nil, err
	}
	db.SetMaxOpenConns(1)
	service := &Service{db: db, lock: lock, attempts: make(map[string]attempt)}
	closeOnError := func(err error) (*Service, error) { service.Close(); return nil, err }
	if _, err = db.Exec(`CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK(id=1), salt BLOB NOT NULL, hash BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);`); err != nil {
		return closeOnError(err)
	}
	err = db.QueryRow("SELECT salt,hash FROM account WHERE id=1").Scan(&service.salt, &service.hash)
	if errors.Is(err, sql.ErrNoRows) {
		if initialPassword == "" {
			// 首次启动生成私密密码文件，不在日志、前端或版本库中泄露密码。
			initialPassword, err = randomToken()
			if err != nil {
				return closeOnError(err)
			}
			passFile, err := os.OpenFile(filepath.Join(dir, "initial-password"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
			if err != nil {
				return closeOnError(fmt.Errorf("初始化密码文件失败，请检查已有文件或指定 FOLIO_PASSWORD_FILE：%w", err))
			}
			_, writeErr := passFile.WriteString(initialPassword + "\n")
			syncErr := passFile.Sync()
			closeErr := passFile.Close()
			if writeErr != nil {
				return closeOnError(writeErr)
			}
			if syncErr != nil {
				return closeOnError(syncErr)
			}
			if closeErr != nil {
				return closeOnError(closeErr)
			}
		}
		if len(initialPassword) < 12 || len(initialPassword) > 1024 {
			return closeOnError(errors.New("初始密码须为 12 到 1024 字节"))
		}
		service.salt = make([]byte, 16)
		if _, err = rand.Read(service.salt); err != nil {
			return closeOnError(err)
		}
		service.hash = argon2.IDKey([]byte(initialPassword), service.salt, 3, 64*1024, 1, 32)
		if _, err = db.Exec("INSERT INTO account(id,salt,hash) VALUES(1,?,?)", service.salt, service.hash); err != nil {
			return closeOnError(err)
		}
	} else if err != nil {
		return closeOnError(err)
	}
	if len(service.salt) != 16 || len(service.hash) != 32 {
		return closeOnError(errors.New("账号数据损坏，拒绝启动"))
	}
	return service, nil
}
func (s *Service) Close() error {
	if s.db != nil {
		s.db.Close()
	}
	return s.lock.Close()
}
func randomToken() (string, error) {
	var bytes [32]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes[:]), nil
}
func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
func (s *Service) Login(username, password, oldToken, remote string) (string, *Principal, error) {
	s.mu.Lock()
	now := time.Now()
	for key, value := range s.attempts {
		if now.After(value.until) {
			delete(s.attempts, key)
		}
	}
	value := s.attempts[remote]
	if value.count >= 5 {
		s.mu.Unlock()
		return "", nil, ErrRateLimited
	}
	// 单用户服务采用全局尝试上限，防止伪造大量来源耗尽 Argon2 内存。
	if len(s.attempts) >= 1000 {
		s.mu.Unlock()
		return "", nil, ErrRateLimited
	}
	value.count++
	value.until = now.Add(10 * time.Minute)
	s.attempts[remote] = value
	s.mu.Unlock()
	s.loginMu.Lock()
	defer s.loginMu.Unlock()
	candidate := argon2.IDKey([]byte(password), s.salt, 3, 64*1024, 1, 32)
	if subtle.ConstantTimeCompare(candidate, s.hash) != 1 || username != "admin" {
		return "", nil, ErrCredentials
	}
	token, err := randomToken()
	if err != nil {
		return "", nil, err
	}
	csrf, err := randomToken()
	if err != nil {
		return "", nil, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return "", nil, err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("DELETE FROM sessions WHERE token_hash=? OR expires<=?", tokenHash(oldToken), now.Unix()); err != nil {
		return "", nil, err
	}
	if _, err = tx.Exec("INSERT INTO sessions(token_hash,csrf,expires) VALUES(?,?,?)", tokenHash(token), csrf, now.Add(SessionLifetime).Unix()); err != nil {
		return "", nil, err
	}
	if err = tx.Commit(); err != nil {
		return "", nil, err
	}
	s.mu.Lock()
	delete(s.attempts, remote)
	s.mu.Unlock()
	return token, &Principal{Username: "admin", CSRF: csrf}, nil
}
func (s *Service) Authenticate(token string) (*Principal, error) {
	if len(token) != 64 {
		return nil, ErrCredentials
	}
	var csrf string
	if err := s.db.QueryRow("SELECT csrf FROM sessions WHERE token_hash=? AND expires>?", tokenHash(token), time.Now().Unix()).Scan(&csrf); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrCredentials
		}
		return nil, err
	}
	return &Principal{Username: "admin", CSRF: csrf}, nil
}
func (s *Service) Logout(token string) error {
	_, err := s.db.Exec("DELETE FROM sessions WHERE token_hash=?", tokenHash(token))
	return err
}
