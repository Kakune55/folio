// Package sharing 管理分享授权与真实文件快照；SQLite 仅保存清单及访问元数据。
package sharing

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"folio/internal/fileio"
	"folio/internal/storage"
	"golang.org/x/crypto/argon2"
	_ "modernc.org/sqlite"
)

type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string                 { return e.Message }
func problem(status int, message string) error { return &Error{status, message} }

type File struct {
	ID       string `json:"id"`
	Path     string `json:"path"`
	Revision string `json:"revision"`
	Size     int64  `json:"size"`
	Viewer   string `json:"viewer"`
}
type Record struct {
	Source    string `json:"source"`
	ID        string `json:"id"`
	Owner     int64  `json:"-"`
	Root      string `json:"root"`
	Title     string `json:"title"`
	Mode      string `json:"mode"`
	Files     []File `json:"files"`
	ExpiresAt int64  `json:"expiresAt"`
	MaxVisits int64  `json:"maxVisits"`
	Visits    int64  `json:"visits"`
	Disabled  bool   `json:"disabled"`
	Protected bool   `json:"protected"`
	CreatedAt int64  `json:"createdAt"`
	Version   string `json:"version"`
	Payload   string `json:"-"`
	Salt      []byte `json:"-"`
	Hash      []byte `json:"-"`
}
type Input struct {
	Version   string               `json:"version"`
	Root      string               `json:"root"`
	Title     string               `json:"title"`
	Mode      string               `json:"mode"`
	Files     []storage.BundleFile `json:"files"`
	ExpiresAt int64                `json:"expiresAt"`
	MaxVisits int64                `json:"maxVisits"`
	Password  *string              `json:"password"`
	Disabled  bool                 `json:"disabled"`
}
type Scan struct {
	Files    []storage.BundleFile `json:"files"`
	Warnings []string             `json:"warnings"`
}
type attempt struct {
	Count int
	Until time.Time
}
type Service struct {
	stop       chan struct{}
	stopped    chan struct{}
	closeOnce  sync.Once
	closeErr   error
	work       chan struct{}
	waiting    chan struct{}
	mu         sync.Mutex
	passwordMu sync.Mutex
	db         *sql.DB
	root       *os.Root
	source     func(int64) (*storage.Store, bool, error)
	attempts   map[string]attempt
}

func random() string {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

// 仅公开分享 ID 缩短；访客令牌、文件 ID 与版本仍保留原随机强度。
func newShareID() string {
	var value [12]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(value[:])
}
func validShareID(value string) bool {
	if validToken(value) {
		return true
	}
	if len(value) != 16 {
		return false
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(value)
	return err == nil && len(decoded) == 12
}
func tokenHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func validToken(value string) bool {
	if len(value) != 48 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func Open(directory string, source func(int64) (*storage.Store, bool, error)) (*Service, error) {
	parent, err := os.OpenRoot(directory)
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	if err = parent.Mkdir("shares", 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	checked, err := fileio.Open(parent, "shares", os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	checked.Close()
	root, err := parent.OpenRoot("shares")
	if err != nil {
		return nil, err
	}
	f, err := fileio.Open(root, "shares.db", os.O_RDWR, 0)
	if errors.Is(err, os.ErrNotExist) {
		f, err = root.OpenFile("shares.db", os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
	}
	if err != nil {
		root.Close()
		return nil, err
	}
	if err = f.Chmod(0600); err != nil {
		f.Close()
		root.Close()
		return nil, err
	}
	f.Close()
	for _, name := range []string{"shares.db-wal", "shares.db-shm", "shares.db-journal"} {
		f, e := fileio.Open(root, name, os.O_RDONLY, 0)
		if e == nil {
			f.Close()
		} else if !errors.Is(e, os.ErrNotExist) {
			root.Close()
			return nil, e
		}
	}
	db, err := sql.Open("sqlite", fileio.FileURL(filepath.Join(directory, "shares", "shares.db"))+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_pragma=trusted_schema(OFF)")
	if err != nil {
		root.Close()
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS shares(id TEXT PRIMARY KEY,owner INTEGER NOT NULL,record TEXT NOT NULL,payload TEXT NOT NULL,salt BLOB,hash BLOB);
 CREATE TABLE IF NOT EXISTS grants(token TEXT NOT NULL,share_id TEXT NOT NULL,version TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(token,share_id));
 CREATE INDEX IF NOT EXISTS shares_owner ON shares(owner); CREATE INDEX IF NOT EXISTS grants_share ON grants(share_id);`)
	if err != nil {
		db.Close()
		root.Close()
		return nil, err
	}
	service := &Service{db: db, root: root, source: source, attempts: map[string]attempt{}, work: make(chan struct{}, 2), waiting: make(chan struct{}, 16)}
	if err = service.cleanStaging(); err != nil {
		service.Close()
		return nil, err
	}
	service.stop = make(chan struct{})
	service.stopped = make(chan struct{})
	if err = service.cleanExpired(time.Now().Unix()); err != nil {
		log.Printf("清理到期分享失败，将自动重试：%v", err)
	}
	go service.expirationLoop()
	return service, nil
}

// 进程锁已由账号服务持有；启动时清理未发布的私有暂存目录，正式快照从不按猜测删除。
func (s *Service) cleanStaging() error {
	f, err := fileio.Open(s.root, ".", os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	owners, err := f.ReadDir(-1)
	f.Close()
	if err != nil {
		return err
	}
	for _, owner := range owners {
		if _, e := strconv.ParseInt(owner.Name(), 10, 64); e != nil {
			continue
		}
		checked, e := fileio.Open(s.root, owner.Name(), os.O_RDONLY, 0)
		if e != nil {
			return e
		}
		entries, e := checked.ReadDir(-1)
		checked.Close()
		if e != nil {
			return e
		}
		for _, entry := range entries {
			suffix := strings.TrimPrefix(entry.Name(), ".folio-tmp-")
			if suffix != entry.Name() && validToken(suffix) {
				if e = s.root.RemoveAll(owner.Name() + "/" + entry.Name()); e != nil {
					return e
				}
			}
		}
	}
	return nil
}

// StartWork 限制载荷读取、渲染与复制并发，有限等候避免普通多图页面被立即拒绝。
func (s *Service) StartWork(ctx context.Context) bool {
	select {
	case s.work <- struct{}{}:
		return true
	default:
	}
	select {
	case s.waiting <- struct{}{}:
	default:
		return false
	}
	defer func() { <-s.waiting }()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case s.work <- struct{}{}:
		return true
	case <-ctx.Done():
		return false
	case <-timer.C:
		return false
	}
}
func (s *Service) EndWork() { <-s.work }
func (s *Service) Close() error {
	s.closeOnce.Do(func() {
		if s.stop != nil {
			close(s.stop)
			<-s.stopped
		}
		s.closeErr = errors.Join(s.db.Close(), s.root.Close())
	})
	return s.closeErr
}
func (s *Service) ownerDir(owner int64) string { return fmt.Sprintf("%d", owner) }
func (s *Service) EnsureOwner(owner int64) error {
	name := s.ownerDir(owner)
	if err := s.root.Mkdir(name, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	f, err := fileio.Open(s.root, name, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	info, err := f.Stat()
	f.Close()
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return problem(500, "分享目录不是普通目录")
	}
	return nil
}
func (s *Service) Usage(owner int64) (int64, error) {
	return fileio.TreeBytes(s.root, s.ownerDir(owner), true)
}
func (s *Service) load(id string) (*Record, error) {
	if !validShareID(id) {
		return nil, problem(404, "分享不存在或已失效")
	}
	var r Record
	var raw string
	err := s.db.QueryRow("SELECT owner,record,payload,salt,hash FROM shares WHERE id=?", id).Scan(&r.Owner, &raw, &r.Payload, &r.Salt, &r.Hash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, problem(404, "分享不存在或已失效")
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal([]byte(raw), &r); err != nil {
		return nil, err
	}
	return &r, nil
}
func (s *Service) save(r *Record) error {
	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	_, err = s.db.Exec("INSERT INTO shares(id,owner,record,payload,salt,hash) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record,payload=excluded.payload,salt=excluded.salt,hash=excluded.hash", r.ID, r.Owner, string(raw), r.Payload, r.Salt, r.Hash)
	return err
}

// 新建必须使用 INSERT，不能通过 UPSERT 覆盖同 ID 的已有分享。
// 调用方持有 s.mu；载荷路径是独立存储位置，重试 ID 不改写或移动载荷。
func (s *Service) insertNew(record *Record, nextID func() string) error {
	for range 8 {
		raw, err := json.Marshal(record)
		if err != nil {
			return err
		}
		result, err := s.db.Exec("INSERT INTO shares(id,owner,record,payload,salt,hash) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING", record.ID, record.Owner, string(raw), record.Payload, record.Salt, record.Hash)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 1 {
			return nil
		}
		record.ID = nextID()
	}
	return problem(503, "无法生成分享链接，请重试")
}
func (s *Service) List(owner int64, offset, limit int) ([]Record, int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.cleanExpiredLocked(time.Now().Unix(), owner); err != nil {
		return nil, 0, fmt.Errorf("清理到期分享失败，请稍后重试：%w", err)
	}
	if offset < 0 || limit < 1 || limit > 50 {
		return nil, 0, problem(400, "分享分页参数无效")
	}
	var total int
	err := s.db.QueryRow("SELECT count(*) FROM shares WHERE owner=?", owner).Scan(&total)
	if err != nil {
		return nil, 0, err
	}
	rows, err := s.db.Query("SELECT record FROM shares WHERE owner=? ORDER BY rowid DESC LIMIT ? OFFSET ?", owner, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []Record{}
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			return nil, 0, err
		}
		var r Record
		if err = json.Unmarshal([]byte(raw), &r); err != nil {
			return nil, 0, err
		}
		out = append(out, r)
	}
	return out, total, rows.Err()
}
func ScanFiles(store *storage.Store, root string, include bool) (Scan, error) {
	out := Scan{Files: []storage.BundleFile{}, Warnings: []string{}}
	queue := []string{root}
	seen := map[string]bool{}
	var total int64
	for len(queue) > 0 {
		name := queue[0]
		queue = queue[1:]
		if seen[name] {
			continue
		}
		seen[name] = true
		if len(seen) > storage.BundleFileLimit {
			return out, problem(413, "递归引用超过 256 个文件，请减少分享范围")
		}
		files, err := store.ReadBundle([]storage.BundleFile{{Path: name}})
		if err != nil {
			if name == root {
				return out, err
			}
			out.Warnings = append(out.Warnings, "「"+name+"」无法包含，请检查文件类型、权限、大小或是否存在")
			continue
		}
		file := files[0]
		total += file.Metadata.Size
		if total > storage.BundleLimit {
			return out, problem(413, "分享包超过 128 MiB，请减少分享范围")
		}
		out.Files = append(out.Files, storage.BundleFile{Path: name, Revision: file.Revision, Metadata: file.Metadata})
		if include && file.Metadata.Viewer == "markdown" {
			refs, warnings := References(name, file.Data)
			queue = append(queue, refs...)
			out.Warnings = append(out.Warnings, warnings...)
		}
	}
	return out, nil
}
func validate(input Input) error {
	if storage.ValidPath(input.Root, false) != nil {
		return problem(400, "主文件路径无效")
	}
	if input.Mode != "snapshot" && input.Mode != "live" {
		return problem(400, "请选择快照或实时分享")
	}
	if input.MaxVisits < 0 || input.MaxVisits > 1_000_000 || input.ExpiresAt < 0 {
		return problem(400, "有效期须在未来，次数为 0 到 1000000（0 表示不限）")
	}
	if len(strings.TrimSpace(input.Title)) == 0 || len(input.Title) > 512 {
		return problem(400, "分享标题不能为空且不得超过 512 字节")
	}
	if input.Password != nil && *input.Password != "" {
		if len(*input.Password) != 6 {
			return problem(400, "访问密码必须是六位数字")
		}
		for _, c := range *input.Password {
			if c < '0' || c > '9' {
				return problem(400, "访问密码必须是六位数字")
			}
		}
	}
	return nil
}
func (s *Service) Save(owner int64, id string, input Input) (*Record, error) {
	if err := validate(input); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var record *Record
	var err error
	if id != "" {
		record, err = s.load(id)
		if err != nil {
			return nil, err
		}
		if record.Owner != owner {
			return nil, problem(404, "分享不存在")
		}
		if record.ExpiresAt != 0 && record.ExpiresAt <= time.Now().Unix() {
			if err = s.deleteRecord(record); err != nil {
				return nil, fmt.Errorf("清理到期分享失败：%w", err)
			}
			return nil, problem(410, "分享已到期并自动删除")
		}
		if input.Version != record.Version {
			return nil, problem(409, "分享设置已变化，请刷新管理列表后重试")
		}
		if record.Root != input.Root || record.Mode != input.Mode {
			return nil, problem(400, "更新不能改变主文件或分享模式，请创建新的分享")
		}
	}
	if input.ExpiresAt != 0 && input.ExpiresAt <= time.Now().Unix() {
		return nil, problem(400, "有效期须在未来")
	}
	if record == nil {
		var count int
		if err = s.db.QueryRow("SELECT count(*) FROM shares WHERE owner=?", owner).Scan(&count); err != nil {
			return nil, err
		}
		if count >= 1000 {
			return nil, problem(413, "每个账号最多保留 1000 条分享，请删除不再使用的分享")
		}
		record = &Record{ID: newShareID(), Owner: owner, Root: input.Root, Mode: input.Mode, CreatedAt: time.Now().Unix(), Files: []File{}}
		if input.Files == nil {
			return nil, problem(400, "请先分析并确认分享文件清单")
		}
	}
	if input.Mode == "live" && ((input.Files != nil && len(input.Files) != 1) || (input.Files == nil && len(record.Files) != 1)) {
		return nil, problem(400, "包含附件的分享只能使用快照模式")
	}
	store, enabled, err := s.source(owner)
	if err != nil {
		return nil, err
	}
	if !enabled {
		return nil, problem(403, "账号已禁用")
	}
	identity, err := store.Identity()
	if err != nil {
		return nil, err
	}
	if record.Source == "" {
		record.Source = tokenHash(identity)
	} else if record.Mode == "live" && record.Source != tokenHash(identity) {
		return nil, problem(409, "原工作区已变化，请重新创建实时分享")
	}

	oldPayload := record.Payload
	var bundle []storage.BundleFile
	if input.Files != nil {
		// 允许主文件和递归引用范围的显式子集，客户端不能夹带未被分析的其他文件。
		scan, e := ScanFiles(store, input.Root, len(input.Files) > 1)
		if e != nil {
			return nil, e
		}
		allowed := map[string]bool{}
		for _, f := range scan.Files {
			allowed[f.Path] = true
		}
		rootIncluded := false
		for _, f := range input.Files {
			if !allowed[f.Path] || f.Revision == "" {
				return nil, problem(400, "清单包含未确认文件，请重新分析")
			}
			if f.Path == input.Root {
				rootIncluded = true
			}
		}
		if !rootIncluded {
			return nil, problem(400, "分享必须包含主文件")
		}
		bundle, err = store.ReadBundle(input.Files)
		if err != nil {
			return nil, err
		}
		record.Files = []File{}
		for _, f := range bundle {
			record.Files = append(record.Files, File{ID: random(), Path: f.Path, Revision: f.Revision, Size: f.Metadata.Size, Viewer: f.Metadata.Viewer})
		}
	}
	record.Title = strings.TrimSpace(input.Title)
	record.ExpiresAt = input.ExpiresAt
	record.MaxVisits = input.MaxVisits
	record.Disabled = input.Disabled
	record.Version = random()
	if input.Password != nil {
		record.Protected = *input.Password != ""
		record.Salt = nil
		record.Hash = nil
		if record.Protected {
			record.Salt = make([]byte, 16)
			if _, err = rand.Read(record.Salt); err != nil {
				return nil, err
			}
			record.Hash = argon2.IDKey([]byte(*input.Password), record.Salt, 3, 64*1024, 1, 32)
		}
	}
	commit := func() error {
		if id == "" {
			return s.insertNew(record, newShareID)
		}
		return s.save(record)
	}
	if bundle != nil && input.Mode == "snapshot" {
		name := s.ownerDir(owner) + "/" + record.ID + "-" + record.Version
		var size int64
		for _, f := range bundle {
			size += int64(len(f.Data))
		}
		err = store.CommitExtra(size, func() error {
			if e := s.writePayload(name, bundle); e != nil {
				if cleanup := s.root.RemoveAll(name); cleanup != nil {
					return errors.Join(e, cleanup)
				}
				return e
			}
			record.Payload = name
			if e := commit(); e != nil {
				_ = s.root.RemoveAll(name)
				return e
			}
			return nil
		})
	} else {
		err = commit()
	}
	if err != nil {
		return nil, err
	}
	if oldPayload != "" && oldPayload != record.Payload {
		if err = s.removePayload(oldPayload); err != nil {
			return record, problem(500, "分享已更新，但旧快照未能清理，空间仍计入配额；请联系管理员检查")
		}
	}
	return record, nil
}
func (s *Service) writePayload(name string, bundle []storage.BundleFile) error {
	owner := path.Dir(name)
	base := path.Base(name)
	temp := ".folio-tmp-" + random()
	parent, err := s.root.OpenRoot(owner)
	if err != nil {
		return err
	}
	defer parent.Close()
	if err = parent.Mkdir(temp, 0700); err != nil {
		return err
	}
	defer parent.RemoveAll(temp)
	root, err := parent.OpenRoot(temp)
	if err != nil {
		return err
	}
	defer root.Close()
	for _, f := range bundle {
		if err = root.MkdirAll(path.Dir(f.Path), 0700); err != nil {
			return err
		}
		file, e := root.OpenFile(f.Path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			return e
		}
		_, e = file.Write(f.Data)
		if e == nil {
			e = fileio.Sync(file)
		}
		closeErr := file.Close()
		if e != nil {
			return e
		}
		if closeErr != nil {
			return closeErr
		}
	}
	// 所有载荷先落盘，数据库提交后才对外可见。
	if err = syncDirectories(root, "."); err != nil {
		return err
	}
	if err = fileio.Rename(parent, temp, parent, base); err != nil {
		return err
	}
	return fileio.SyncRoot(parent)
}
func syncDirectories(root *os.Root, name string) error {
	f, err := fileio.Open(root, name, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	entries, err := f.ReadDir(-1)
	f.Close()
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() {
			if err = syncDirectories(root, path.Join(name, e.Name())); err != nil {
				return err
			}
		}
	}
	dir, err := root.OpenRoot(name)
	if err != nil {
		return err
	}
	defer dir.Close()
	return fileio.SyncRoot(dir)
}
func (s *Service) removePayload(name string) error {
	if err := s.root.RemoveAll(name); err != nil {
		return err
	}
	parent, err := s.root.OpenRoot(path.Dir(name))
	if err != nil {
		return err
	}
	defer parent.Close()
	return fileio.SyncRoot(parent)
}

func (s *Service) Delete(owner int64, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, err := s.load(id)
	if err != nil {
		return err
	}
	if r.Owner != owner {
		return problem(404, "分享不存在")
	}
	return s.deleteRecord(r)
}

// 调用方持有 s.mu；清理失败保留记录，下一轮可继续重试。
func (s *Service) deleteRecord(r *Record) error {
	id := r.ID
	var err error
	// 先撤销，再清理；清理失败时保留管理记录供重试。
	r.Disabled = true
	r.Version = random()
	if err = s.save(r); err != nil {
		return err
	}
	if r.Payload != "" {
		if err = s.removePayload(r.Payload); err != nil {
			return err
		}
	}
	if _, err = s.db.Exec("DELETE FROM grants WHERE share_id=?", id); err != nil {
		return err
	}
	_, err = s.db.Exec("DELETE FROM shares WHERE id=?", id)
	return err
}
func (s *Service) available(r *Record) error {
	if r.Disabled || (r.ExpiresAt != 0 && time.Now().Unix() >= r.ExpiresAt) {
		return problem(410, "分享已暂停或过期")
	}
	store, enabled, err := s.source(r.Owner)
	if err != nil {
		return err
	}
	if !enabled {
		return problem(410, "分享者账号已停用")
	}
	if r.Mode == "live" {
		identity, e := store.Identity()
		if e != nil {
			return e
		}
		if tokenHash(identity) != r.Source {
			return problem(410, "原工作区已变化，实时分享已失效")
		}
	}
	return nil
}
func (s *Service) Info(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, err := s.load(id)
	if err != nil {
		return false, err
	}
	if err = s.available(r); err != nil {
		return false, err
	}
	return r.Protected, nil
}

const GrantLifetime = 30 * time.Minute

func (s *Service) grant(r *Record, token string) (bool, error) {
	if !validToken(token) {
		return false, nil
	}
	var version string
	var expires int64
	err := s.db.QueryRow("SELECT version,expires FROM grants WHERE token=? AND share_id=?", tokenHash(token), r.ID).Scan(&version, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return version == r.Version && expires > time.Now().Unix(), nil
}
func (s *Service) Enter(id, password, existing, remote string) (*Record, string, error) {
	if !s.passwordMu.TryLock() {
		return nil, "", problem(429, "正在验证其他分享请求，请稍后重试")
	}
	defer s.passwordMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	r, err := s.load(id)
	if err != nil {
		return nil, "", err
	}
	if err = s.available(r); err != nil {
		return nil, "", err
	}
	existingGrant, grantErr := s.grant(r, existing)
	if grantErr != nil {
		return nil, "", grantErr
	}
	if existingGrant {
		return r, existing, nil
	}
	now := time.Now()
	key := id + ":" + remote
	for k, a := range s.attempts {
		if now.After(a.Until) {
			delete(s.attempts, k)
		}
	}
	a := s.attempts[key]
	if a.Count >= 5 && now.Before(a.Until) {
		return nil, "", problem(429, "密码尝试过多，请十分钟后重试")
	}
	if r.Protected {
		if len(password) != 6 || subtle.ConstantTimeCompare(argon2.IDKey([]byte(password), r.Salt, 3, 64*1024, 1, 32), r.Hash) != 1 {
			if len(s.attempts) >= 4096 {
				return nil, "", problem(429, "分享验证繁忙，请稍后重试")
			}
			s.attempts[key] = attempt{a.Count + 1, now.Add(10 * time.Minute)}
			return nil, "", problem(403, "分享密码不正确")
		}
	}
	if r.MaxVisits > 0 && r.Visits >= r.MaxVisits {
		return nil, "", problem(410, "分享访问次数已用完")
	}
	// mutex 与 SQLite 事务共同保护最后一次访问；重启后计数及授权仍保留。
	token := random()
	if validToken(existing) {
		var known int
		if e := s.db.QueryRow("SELECT count(*) FROM grants WHERE token=?", tokenHash(existing)).Scan(&known); e != nil {
			return nil, "", e
		} else if known > 0 {
			token = existing
		}
	}
	r.Visits++
	raw, _ := json.Marshal(r)
	tx, err := s.db.Begin()
	if err != nil {
		return nil, "", err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("UPDATE shares SET record=? WHERE id=?", string(raw), id); err != nil {
		return nil, "", err
	}
	if _, err = tx.Exec("DELETE FROM grants WHERE expires<=?", now.Unix()); err != nil {
		return nil, "", err
	}
	var active int
	if err = tx.QueryRow("SELECT count(*) FROM grants").Scan(&active); err != nil {
		return nil, "", err
	}
	var pair int
	if err = tx.QueryRow("SELECT count(*) FROM grants WHERE token=? AND share_id=?", tokenHash(token), id).Scan(&pair); err != nil {
		return nil, "", err
	}
	if active >= 10000 && pair == 0 {
		return nil, "", problem(429, "访客授权容量已满，请稍后重试")
	}
	if _, err = tx.Exec("INSERT INTO grants(token,share_id,version,expires) VALUES(?,?,?,?) ON CONFLICT(token,share_id) DO UPDATE SET version=excluded.version,expires=excluded.expires", tokenHash(token), id, r.Version, now.Add(GrantLifetime).Unix()); err != nil {
		return nil, "", err
	}
	if err = tx.Commit(); err != nil {
		return nil, "", err
	}
	delete(s.attempts, key)
	return r, token, nil
}
func (s *Service) authorized(id, token string) (*Record, error) {
	r, err := s.load(id)
	if err != nil {
		return nil, err
	}
	if err = s.available(r); err != nil {
		return nil, err
	}
	valid, grantErr := s.grant(r, token)
	if grantErr != nil {
		return nil, grantErr
	}
	if !valid {
		return nil, problem(403, "请重新进入分享或输入访问密码")
	}
	return r, nil
}
func (s *Service) Manifest(id, token string) (*Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.authorized(id, token)
}
func (s *Service) read(r *Record, fileID string) (storage.BundleFile, error) {
	var selected *File
	for i := range r.Files {
		if r.Files[i].ID == fileID {
			selected = &r.Files[i]
			break
		}
	}
	if selected == nil {
		return storage.BundleFile{}, problem(404, "此文件未包含在分享中")
	}
	var store *storage.Store
	var err error
	if r.Mode == "snapshot" {
		checked, checkErr := fileio.Open(s.root, r.Payload, os.O_RDONLY, 0)
		if checkErr != nil {
			return storage.BundleFile{}, checkErr
		}
		checked.Close()
		store, err = storage.Open(filepath.Join(s.root.Name(), filepath.FromSlash(r.Payload)))
		if err == nil {
			defer store.Close()
			ownerStore, _, limitErr := s.source(r.Owner)
			if limitErr != nil {
				return storage.BundleFile{}, limitErr
			}
			if limitErr = store.SetLimits(ownerStore.Limits()); limitErr != nil {
				return storage.BundleFile{}, limitErr
			}
		}
	} else {
		store, _, err = s.source(r.Owner)
	}
	if err != nil {
		return storage.BundleFile{}, err
	}
	revision := ""
	if r.Mode == "snapshot" {
		revision = selected.Revision
	}
	files, err := store.ReadBundle([]storage.BundleFile{{Path: selected.Path, Revision: revision}})
	if err != nil {
		return storage.BundleFile{}, err
	}
	return files[0], nil
}
func (s *Service) File(id, token, fileID string) (storage.BundleFile, *Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, err := s.authorized(id, token)
	if err != nil {
		return storage.BundleFile{}, nil, err
	}
	f, err := s.read(r, fileID)
	return f, r, err
}
func (s *Service) Import(id, token, fileID string, receiver int64, directory string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, err := s.authorized(id, token)
	if err != nil {
		return "", err
	}
	files := []storage.BundleFile{}
	isRoot := false
	for _, f := range r.Files {
		if f.ID == fileID && f.Path == r.Root {
			isRoot = true
		}
	}
	for _, f := range r.Files {
		if !isRoot && f.ID != fileID {
			continue
		}
		data, e := s.read(r, f.ID)
		if e != nil {
			return "", e
		}
		if data.Metadata.Viewer == "markdown" && isRoot {
			data.Data, e = Relocate(data.Path, data.Data)
			if e != nil {
				return "", e
			}
		}
		if !isRoot {
			data.Path = path.Base(data.Path)
		}
		files = append(files, data)
	}
	if len(files) == 0 {
		return "", problem(404, "文件未包含在分享中")
	}
	store, enabled, err := s.source(receiver)
	if err != nil {
		return "", err
	}
	if !enabled {
		return "", problem(403, "接收账号已禁用")
	}
	result, err := store.ImportBundle(directory, files)
	return result, err
}

// 排序只用于稳定展示；真实清单保留主文件在首位。
func SortScan(scan *Scan) {
	if len(scan.Files) > 1 {
		sort.Slice(scan.Files[1:], func(i, j int) bool { return scan.Files[i+1].Path < scan.Files[j+1].Path })
	}
}
