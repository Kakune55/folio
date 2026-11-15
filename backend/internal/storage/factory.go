package storage

import (
	"context"
	"database/sql"
	"errors"
	"folio/internal/fileio"
	"folio/internal/layout"
	"folio/internal/trash"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

type DiskUsage struct {
	Total       uint64 `json:"total"`
	Available   uint64 `json:"available"`
	VolumeError string `json:"volumeError,omitempty"`
	Bytes       int64  `json:"bytes"`
	Files       int64  `json:"files"`
	Directories int64  `json:"directories"`
}
type Factory interface {
	OpenUser(int64) (Workspace, error)
	DiskUsage(context.Context) (DiskUsage, error)
	Close() error
}
type LocalBackend struct {
	mu        sync.Mutex
	users     map[int64]*Store
	directory string
	root      *os.Root
}

func NewLocal(directory, appData string, db *sql.DB) (*LocalBackend, error) {
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			root.Close()
		}
	}()
	data, err := os.OpenRoot(appData)
	if err != nil {
		return nil, err
	}
	defer data.Close()
	complete, err := layout.Complete(db)
	if err != nil {
		return nil, err
	}
	if !complete {
		legacy, e := layout.HasLegacy(data)
		if e != nil {
			return nil, e
		}
		if legacy {
			return nil, errors.New("检测到旧存储布局，请停服运行 -migrate-storage -workspace <工作区> -app-data <应用数据>")
		}
		if err = layout.CheckNames(root); err != nil {
			return nil, err
		}
		if err = layout.MarkComplete(db); err != nil {
			return nil, err
		}
	}
	if err = BindBackend(db, "local"); err != nil {
		return nil, err
	}
	ok = true
	return &LocalBackend{directory: directory, root: root, users: map[int64]*Store{}}, nil
}
func BindBackend(db *sql.DB, identity string) error {
	if _, err := db.Exec("CREATE TABLE IF NOT EXISTS workspace_backend(id INTEGER PRIMARY KEY CHECK(id=1),identity TEXT NOT NULL)"); err != nil {
		return err
	}
	var current string
	err := db.QueryRow("SELECT identity FROM workspace_backend WHERE id=1").Scan(&current)
	if errors.Is(err, sql.ErrNoRows) {
		if strings.HasPrefix(identity, "s3:") {
			complete, e := layout.Complete(db)
			if e != nil {
				return e
			}
			if complete {
				return errors.New("已有本地布局，必须先执行 -storage-migrate local s3，不能直接切换后端")
			}
		}

		_, err = db.Exec("INSERT INTO workspace_backend VALUES(1,?)", identity)
		return err
	}
	if err != nil {
		return err
	}
	if current != identity {
		return errors.New("工作区存储配置与核心库绑定不一致；禁止直接切换空后端，请先停服迁移")
	}
	return nil
}
func (b *LocalBackend) OpenUser(id int64) (Workspace, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if s := b.users[id]; s != nil {
		return s, nil
	}
	s, err := OpenManaged(b.directory, id)
	if err != nil {
		return nil, err
	}
	bin, err := trash.Open(filepath.Join(b.directory, strconv.FormatInt(id, 10), ".folio", "trash"))
	if err != nil {
		s.Close()
		return nil, err
	}
	s.trash = bin
	b.users[id] = s
	return s, nil
}
func (b *LocalBackend) Close() error { return b.root.Close() }
func (b *LocalBackend) DiskUsage(ctx context.Context) (DiskUsage, error) {
	return LocalDiskUsage(ctx, b.directory)
}
func LocalDiskUsage(ctx context.Context, directory string) (DiskUsage, error) {
	root, err := os.OpenRoot(directory)
	if err != nil {
		return DiskUsage{}, err
	}
	defer root.Close()
	var u DiskUsage
	err = fs.WalkDir(root.FS(), ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		if d.IsDir() {
			u.Directories++
			return nil
		}
		f, err := fileio.Open(root, name, os.O_RDONLY, 0)
		if err != nil {
			return err
		}
		info, err := f.Stat()
		f.Close()
		if err != nil {
			return err
		}
		u.Files++
		u.Bytes += info.Size()
		return nil
	})
	if err != nil {
		return u, err
	}
	u.Total, u.Available, err = volumeSpace(directory)
	if err != nil {
		u.VolumeError = "所在磁盘容量不可用"
	}
	return u, nil
}
func (b *S3Backend) Close() error { return nil }
func (b *S3Backend) DiskUsage(ctx context.Context) (DiskUsage, error) {
	r := &S3Store{backend: b, prefix: b.opts.Prefix}
	if r.prefix != "" {
		r.prefix += "/"
	}
	all, err := r.objects()
	u := DiskUsage{VolumeError: "对象存储不提供所在磁盘容量"}
	for _, o := range all {
		if e := ctx.Err(); e != nil {
			return u, e
		}
		u.Files++
		u.Bytes += o.Size
	}
	return u, err
}
func (b *S3Backend) Binding() string {
	return "s3:" + digest([]byte(b.opts.Endpoint+"\x00"+b.opts.Bucket+"\x00"+b.opts.Prefix))
}

// Activate 先核对已有绑定，再验证远端能力；错误端点不能在新核心库留下不可更正的绑定。
func (b *S3Backend) Activate(db *sql.DB) error {
	if _, err := db.Exec("CREATE TABLE IF NOT EXISTS workspace_backend(id INTEGER PRIMARY KEY CHECK(id=1),identity TEXT NOT NULL)"); err != nil {
		return err
	}
	var current string
	err := db.QueryRow("SELECT identity FROM workspace_backend WHERE id=1").Scan(&current)
	if errors.Is(err, sql.ErrNoRows) {
		complete, e := layout.Complete(db)
		if e != nil {
			return e
		}
		if complete {
			return errors.New("已有本地布局，必须先执行 -storage-migrate local s3，不能直接切换后端")
		}
	} else if err != nil {
		return err
	} else if current != b.Binding() {
		return errors.New("工作区存储配置与核心库绑定不一致，请检查配置或使用离线迁移")
	}
	if _, err = b.OpenUser(1); err != nil {
		return err
	}
	return BindBackend(db, b.Binding())
}
