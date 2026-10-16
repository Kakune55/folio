package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"folio/internal/fileio"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"
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
	root       *os.Root
	salt, hash []byte
	mu         sync.Mutex
	attempts   map[string]attempt
	loginMu    sync.Mutex
}

var ErrCredentials = errors.New("账号或密码错误")
var ErrRateLimited = errors.New("尝试次数过多，请稍后重试")
var ErrLoginBusy = errors.New("正在验证其他登录请求，请稍后重试")

func Open(dir, initialPassword string) (*Service, error) {
	return open(dir, initialPassword, false)
}

func open(dir, initialPassword string, existingOnly bool) (*Service, error) {
	root, err := privateDirectory(dir)
	if err != nil {
		return nil, err
	}
	keepRoot := false
	defer func() {
		if !keepRoot {
			root.Close()
		}
	}()
	// 重置不能因路径写错而初始化一套新账号。
	if existingOnly {
		file, err := privateFile(root, "app.db", false)
		if err != nil {
			return nil, err
		}
		file.Close()
	}
	lock, err := privateFile(root, "instance.lock", true)
	if err != nil {
		return nil, err
	}
	if err = fileio.Lock(lock); err != nil {
		lock.Close()
		return nil, errors.New("此应用数据目录已有运行中的实例")
	}
	f, err := privateFile(root, "app.db", !existingOnly)
	if err != nil {
		lock.Close()
		return nil, err
	}
	if err = f.Chmod(0o600); err != nil {
		f.Close()
		lock.Close()
		return nil, err
	}
	f.Close()
	for _, name := range []string{"app.db-wal", "app.db-shm", "app.db-journal"} {
		file, err := privateFile(root, name, false)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			lock.Close()
			return nil, err
		}
		file.Close()
	}
	// SQLite 在受信任的应用数据目录中按普通路径打开，访问权限由运行用户/ACL 管理。
	uri := fileio.FileURL(filepath.Join(root.Name(), "app.db")) + "?_pragma=busy_timeout(5000)&_pragma=trusted_schema(OFF)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)"
	db, err := sql.Open("sqlite", uri)
	if err != nil {
		lock.Close()
		return nil, err
	}
	db.SetMaxOpenConns(1)
	service := &Service{db: db, lock: lock, root: root, attempts: make(map[string]attempt)}
	keepRoot = true
	closeOnError := func(err error) (*Service, error) { service.Close(); return nil, err }
	if !existingOnly {
		if _, err = db.Exec(`CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK(id=1), salt BLOB NOT NULL, hash BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);`); err != nil {
			return closeOnError(err)
		}
	}
	err = db.QueryRow("SELECT salt,hash FROM account WHERE id=1").Scan(&service.salt, &service.hash)
	if errors.Is(err, sql.ErrNoRows) {
		if existingOnly {
			return closeOnError(errors.New("账号不存在，拒绝重置或初始化"))
		}
		if initialPassword == "" {
			// 首次启动生成私密密码文件，不在日志、前端或版本库中泄露密码。
			initialPassword, err = randomToken()
			if err != nil {
				return closeOnError(err)
			}
			passFile, err := createPrivateFile(root, "initial-password")
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
			if err = fileio.SyncRoot(root); err != nil {
				return closeOnError(err)
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

// WorkspaceID 混入账号初始化盐，既不暴露根路径，也不复用另一套应用数据的恢复记录。
func (s *Service) WorkspaceID(identity string) string {
	sum := sha256.Sum256([]byte("folio-workspace-v1:" + hex.EncodeToString(s.salt) + ":" + identity))
	return hex.EncodeToString(sum[:])
}
func (s *Service) Close() error {
	var err error
	if s.db != nil {
		err = s.db.Close()
	}
	return errors.Join(err, s.lock.Close(), s.root.Close())
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
	// 不让突发请求排队等待高成本哈希；只允许一个在途校验，其他请求立即重试。
	if !s.loginMu.TryLock() {
		return "", nil, ErrLoginBusy
	}
	defer s.loginMu.Unlock()
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
