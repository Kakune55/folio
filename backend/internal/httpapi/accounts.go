package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"folio/internal/auth"
	"folio/internal/config"
	"folio/internal/fileio"
	"folio/internal/search"
	"folio/internal/sharing"
	"folio/internal/storage"
	"folio/internal/trash"
)

type accountWorkspace struct {
	handler http.Handler
	store   *storage.Store
	index   *search.Index
	trash   *trash.Repository
	id      string
}
type Accounts struct {
	shares  *sharing.Service
	started time.Time
	diskMu  sync.Mutex
	mu      sync.Mutex
	cfg     config.Config
	auth    *auth.Service
	assets  fs.FS
	roots   *os.Root
	data    *os.Root
	entries map[int64]*accountWorkspace
	base    http.Handler
}

func NewAccounts(assets fs.FS, cfg config.Config, accounts *auth.Service) (*Accounts, error) {
	roots, err := os.OpenRoot(cfg.Workspace)
	if err != nil {
		return nil, err
	}
	data, err := os.OpenRoot(cfg.AppData)
	if err != nil {
		roots.Close()
		return nil, err
	}
	raw, err := accounts.SystemSettings()
	if err != nil {
		roots.Close()
		data.Close()
		return nil, err
	}
	if len(raw) > 0 {
		var saved systemSettings
		if err = json.Unmarshal(raw, &saved); err == nil {
			err = saved.validate()
		}
		if err != nil {
			roots.Close()
			data.Close()
			return nil, err
		}
		cfg.Limits = saved.Limits
		cfg.IndexLimit = saved.IndexLimit
	}
	a := &Accounts{started: time.Now(), cfg: cfg, auth: accounts, assets: assets, roots: roots, data: data, entries: map[int64]*accountWorkspace{}}
	a.shares, err = sharing.Open(cfg.AppData, func(id int64) (*storage.Store, bool, error) {
		user, e := a.auth.User(id)
		if e != nil {
			return nil, false, e
		}
		entry, e := a.get(id)
		if e != nil {
			return nil, false, e
		}
		return entry.store, user.Enabled, nil
	})
	if err != nil {
		roots.Close()
		data.Close()
		return nil, err
	}
	a.base = New(assets, a.options())
	return a, nil
}
func (a *Accounts) options() Options {
	return Options{Shares: a.shares, System: a, Auth: a.auth, SecureCookie: a.cfg.SecureCookie, Origin: a.cfg.Origin, WorkspaceFor: func(id int64) (string, error) {
		entry, err := a.get(id)
		if err != nil {
			return "", err
		}
		return entry.id, nil
	}, UserUsage: func(id int64) (storage.Usage, error) {
		entry, err := a.get(id)
		if err != nil {
			return storage.Usage{}, err
		}
		return entry.store.Usage()
	}}
}
func (a *Accounts) get(id int64) (*accountWorkspace, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if entry := a.entries[id]; entry != nil {
		return entry, nil
	}
	if _, err := a.auth.User(id); err != nil {
		return nil, err
	}
	name := fmt.Sprintf("%d", id)
	// 创建前后都验证托管目录，绝不将链接目录作为用户根。
	for _, root := range []*os.Root{a.roots, a.data} {
		if err := root.Mkdir(name, 0700); err != nil && !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		f, err := fileio.Open(root, name, os.O_RDONLY, 0)
		if err != nil {
			return nil, err
		}
		info, err := f.Stat()
		f.Close()
		if err != nil {
			return nil, err
		}
		if !info.IsDir() {
			return nil, errors.New("用户工作区不是目录")
		}
	}
	store, err := storage.Open(filepath.Join(a.cfg.Workspace, name))
	if err != nil {
		return nil, err
	}
	if err = store.SetLimits(a.cfg.Limits); err != nil {
		store.Close()
		return nil, err
	}
	recovery, err := trash.Open(filepath.Join(a.cfg.AppData, name, "trash"))
	if err != nil {
		store.Close()
		return nil, err
	}
	store.SetTrash(recovery)
	if err = a.shares.EnsureOwner(id); err != nil {
		recovery.Close()
		store.Close()
		return nil, err
	}
	store.SetExtraUsage(func() (int64, error) { return a.shares.Usage(id) })
	store.SetQuota(func() (int64, error) { u, err := a.auth.User(id); return u.Quota, err })
	index, err := search.Open(filepath.Join(a.cfg.AppData, name), store, a.cfg.IndexLimit)
	if err != nil {
		recovery.Close()
		store.Close()
		return nil, err
	}
	identity, err := store.Identity()
	if err != nil {
		index.Close()
		recovery.Close()
		store.Close()
		return nil, err
	}
	options := a.options()
	options.Workspace = store
	options.Search = index
	options.OwnerID = id
	options.WorkspaceID = a.auth.WorkspaceID(fmt.Sprintf("user:%d:%s", id, identity))
	entry := &accountWorkspace{handler: New(a.assets, options), store: store, index: index, trash: recovery, id: options.WorkspaceID}
	a.entries[id] = entry
	return entry, nil
}
func (a *Accounts) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// 接口契约只有静态公开定义，不打开账号工作区。
	if r.URL.Path == "/api/v1/openapi.json" || r.URL.Path == "/api/v1/agent.md" {
		a.base.ServeHTTP(w, r)
		return
	}
	// 登录与静态文件使用公共路由；所有业务资源按服务端身份分派。
	if !strings.HasPrefix(r.URL.Path, "/api/v1/public/") && strings.HasPrefix(r.URL.Path, "/api/v1/") && r.URL.Path != "/api/v1/auth/login" && r.URL.Path != "/api/v1/healthz" {
		p, access, err := authenticateRequest(a.auth, r)
		if access != nil && !authorizeToken(access, r) {
			w.Header().Set("Cache-Control", "no-store")
			writeError(w, 403, "token_forbidden", "访问令牌没有此接口的权限", nil)
			return
		}
		if err == nil {
			entry, err := a.get(p.ID)
			if err != nil {
				log.Printf("用户工作区打开失败：%v", err)
				w.Header().Set("Cache-Control", "no-store")
				writeError(w, 503, "workspace_unavailable", "工作区打开失败，请重试或联系管理员", nil)
				return
			}
			entry.handler.ServeHTTP(w, r)
			return
		}
	}
	a.base.ServeHTTP(w, r)
}
func (a *Accounts) Close() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	var err error
	for _, e := range a.entries {
		err = errors.Join(err, e.index.Close(), e.trash.Close(), e.store.Close())
	}
	return errors.Join(err, a.shares.Close(), a.roots.Close(), a.data.Close())
}
