package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"folio/internal/auth"
	"folio/internal/config"
	"folio/internal/search"
	"folio/internal/sharing"
	"folio/internal/storage"
)

type accountWorkspace struct {
	events  *changeHub
	handler http.Handler
	store   storage.Workspace
	index   *search.Index
	id      string
}
type Accounts struct {
	eventsStopped bool
	shares        *sharing.Service
	started       time.Time
	diskMu        sync.Mutex
	mu            sync.Mutex
	cfg           config.Config
	auth          *auth.Service
	assets        fs.FS
	backend       storage.Factory
	entries       map[int64]*accountWorkspace
	base          http.Handler
	downloads     *mcpDownloads
}

func NewAccounts(assets fs.FS, cfg config.Config, accounts *auth.Service) (*Accounts, error) {
	var backend storage.Factory
	var err error
	if cfg.StorageBackend == "s3" {
		var remote *storage.S3Backend
		remote, err = storage.NewS3(context.Background(), cfg.S3)
		if err == nil {
			err = remote.Activate(accounts.Database())
		}
		backend = remote
	} else {
		backend, err = storage.NewLocal(cfg.Workspace, cfg.AppData, accounts.Database())
	}
	if err != nil {
		return nil, err
	}
	demoUser, demoSeeded, err := accounts.ConfigureDemo(cfg.DemoMode)
	if err != nil {
		backend.Close()
		return nil, fmt.Errorf("配置 Demo 账号失败，请使用独立演示数据目录或检查现有账号：%w", err)
	}
	raw, err := accounts.SystemSettings()
	if err != nil {
		backend.Close()
		return nil, err
	}
	if len(raw) > 0 {
		var saved systemSettings
		if err = json.Unmarshal(raw, &saved); err == nil {
			err = saved.validate()
		}
		if err != nil {
			backend.Close()
			return nil, err
		}
		cfg.Limits = saved.Limits
		cfg.IndexLimit = saved.IndexLimit
	}
	a := &Accounts{started: time.Now(), cfg: cfg, auth: accounts, assets: assets, backend: backend, entries: map[int64]*accountWorkspace{}}
	a.shares, err = sharing.Open(accounts.Database(), func(id int64) (storage.Workspace, bool, error) {
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
		backend.Close()
		return nil, err
	}
	if err = a.shares.Start(); err != nil {
		a.Close()
		return nil, err
	}
	a.downloads = newMCPDownloads(a.auth, func(id int64) (storage.Workspace, string, error) {
		entry, err := a.get(id)
		if err != nil {
			return nil, "", err
		}
		return entry.store, entry.id, nil
	})
	a.base = New(assets, a.options())
	if cfg.DemoMode && !demoSeeded {
		if err := a.seedDemoWorkspace(demoUser); err != nil {
			a.Close()
			return nil, err
		}
	}
	return a, nil
}
func (a *Accounts) options() Options {
	return Options{MCPDownloads: a.downloads, Shares: a.shares, System: a, Auth: a.auth, SecureCookie: a.cfg.SecureCookie, Origin: a.cfg.Origin, WorkspaceFor: func(id int64) (string, error) {
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
	store, err := a.backend.OpenUser(id)
	if err != nil {
		return nil, err
	}
	if err = store.SetLimits(a.cfg.Limits); err != nil {
		store.Close()
		return nil, err
	}
	store.SetQuota(func() (int64, error) { u, e := a.auth.User(id); return u.Quota, e })
	index, err := search.OpenUser(a.cfg.AppData, id, store, a.cfg.IndexLimit)
	if err != nil {
		store.Close()
		return nil, err
	}
	identity, err := store.Identity()
	if err != nil {
		index.Close()
		store.Close()
		return nil, err
	}
	options := a.options()
	options.Workspace = store
	options.Search = index
	options.Events = newChangeHub()
	if a.eventsStopped {
		options.Events.close()
	}
	options.OwnerID = id
	options.WorkspaceID = a.auth.WorkspaceID(fmt.Sprintf("user:%d:%s", id, identity))
	entry := &accountWorkspace{events: options.Events, handler: New(a.assets, options), store: store, index: index, id: options.WorkspaceID}
	a.entries[id] = entry
	return entry, nil
}
func (a *Accounts) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// 接口契约只有静态公开定义，不打开账号工作区。
	if isApplicationDocumentation(r.URL.Path) {
		a.base.ServeHTTP(w, r)
		return
	}
	// 登录与静态文件使用公共路由；所有业务资源按服务端身份分派。
	if r.URL.Path == "/mcp" || (!strings.HasPrefix(r.URL.Path, "/api/v1/public/") && strings.HasPrefix(r.URL.Path, "/api/v1/") && r.URL.Path != "/api/v1/auth/login" && r.URL.Path != "/api/v1/healthz") {
		p, access, err := authenticateRequest(a.auth, r)
		if access != nil && r.URL.Path != "/mcp" && !authorizeToken(access, r) {
			w.Header().Set("Cache-Control", "no-store")
			writeError(w, 403, "token_forbidden", "访问令牌没有此接口的权限", nil)
			return
		}
		if err == nil && (r.URL.Path != "/mcp" || access != nil) {
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
	shareErr := a.shares.Close()
	a.mu.Lock()
	defer a.mu.Unlock()
	a.eventsStopped = true
	var err error
	for _, e := range a.entries {
		if e.events != nil {
			e.events.close()
		}
		err = errors.Join(err, e.index.Close(), e.store.Close())
	}
	return errors.Join(err, shareErr, a.backend.Close())
}
