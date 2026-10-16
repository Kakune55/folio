package httpapi

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"runtime"
	"time"

	"folio/internal/storage"
)

type systemSettings struct {
	Limits     storage.Limits `json:"limits"`
	IndexLimit int64          `json:"indexLimit"`
}

func (s systemSettings) validate() error {
	l := s.Limits
	if l.Text < 1 || l.Text > 100<<20 || l.Attachment < 1 || l.Attachment > 1<<30 || l.Image < 1 || l.Image > l.Attachment || l.PDF < 1 || l.PDF > l.Attachment || l.ImagePixels < 1 || l.ImagePixels > 1_000_000_000 || s.IndexLimit < 1 || s.IndexLimit > 100<<20 {
		return errors.New("文本及索引上限为 1 字节–100 MiB，附件最多 1 GiB，图片/PDF 不得超过附件上限，像素数为 1–10 亿")
	}
	return nil
}
func (a *api) registerSystem(mux *http.ServeMux) {
	if a.System == nil {
		return
	}
	manager := a.System
	mux.HandleFunc("GET /api/v1/admin/settings", a.administrator(func(w http.ResponseWriter, r *http.Request) {
		manager.mu.Lock()
		value := systemSettings{manager.cfg.Limits, manager.cfg.IndexLimit}
		manager.mu.Unlock()
		writeJSON(w, 200, value)
	}))
	mux.HandleFunc("PUT /api/v1/admin/settings", a.administrator(func(w http.ResponseWriter, r *http.Request) {
		var value systemSettings
		if !decodeJSON(w, r, 4096, &value) {
			return
		}
		if err := value.validate(); err != nil {
			writeError(w, 400, "invalid_settings", err.Error(), nil)
			return
		}
		manager.mu.Lock()
		defer manager.mu.Unlock()
		raw, err := json.Marshal(value)
		if err == nil {
			err = manager.auth.SaveSystemSettings(raw)
		}
		if err != nil {
			writeError(w, 500, "settings_failed", "设置保存失败，请重试；当前配置未改变", nil)
			return
		}
		manager.cfg.Limits = value.Limits
		manager.cfg.IndexLimit = value.IndexLimit
		for _, entry := range manager.entries {
			_ = entry.store.SetLimits(value.Limits)
			entry.index.SetBodyLimit(value.IndexLimit)
		}
		writeJSON(w, 200, value)
	}))
	mux.HandleFunc("GET /api/v1/admin/status", a.administrator(func(w http.ResponseWriter, r *http.Request) {
		var mem runtime.MemStats
		runtime.ReadMemStats(&mem)
		manager.mu.Lock()
		indexes, files := len(manager.entries), 0
		for _, entry := range manager.entries {
			files += entry.index.Status().Files
		}
		manager.mu.Unlock()
		lastPause := uint64(0)
		if mem.NumGC > 0 {
			lastPause = mem.PauseNs[(mem.NumGC-1)%256]
		}
		sinceGC := float64(0)
		if mem.LastGC > 0 {
			sinceGC = float64(time.Now().UnixNano()-int64(mem.LastGC)) / 1e9
		}
		writeJSON(w, 200, map[string]any{"goVersion": runtime.Version(), "platform": runtime.GOOS + "/" + runtime.GOARCH, "uptime": time.Since(manager.started).Seconds(), "goroutines": runtime.NumGoroutine(), "cpus": runtime.NumCPU(), "openWorkspaces": indexes, "indexedFiles": files, "memory": mem, "lastPauseNs": lastPause, "sinceGC": sinceGC})
	}))
	// 磁盘目录统计由显式操作触发，不随运行时状态轮询。
	mux.HandleFunc("GET /api/v1/admin/disk", a.administrator(func(w http.ResponseWriter, r *http.Request) {
		if !manager.diskMu.TryLock() {
			writeError(w, 409, "operation_in_progress", "磁盘统计正在进行，请稍后重试", nil)
			return
		}
		defer manager.diskMu.Unlock()
		type usage struct {
			Total       uint64 `json:"total"`
			Available   uint64 `json:"available"`
			VolumeError string `json:"volumeError,omitempty"`
			Bytes       int64  `json:"bytes"`
			Files       int64  `json:"files"`
			Directories int64  `json:"directories"`
		}
		values := map[string]usage{}
		for name, root := range map[string]fs.FS{"workspace": manager.roots.FS(), "appData": manager.data.FS()} {
			var u usage
			err := fs.WalkDir(root, ".", func(path string, d fs.DirEntry, err error) error {
				if err != nil {
					return err
				}
				if err := r.Context().Err(); err != nil {
					return err
				}
				if d.IsDir() {
					u.Directories++
					return nil
				}
				if !d.Type().IsRegular() {
					return nil
				}
				info, err := d.Info()
				if err != nil {
					return err
				}
				u.Files++
				u.Bytes += info.Size()
				return nil
			})
			if err != nil {
				writeError(w, 503, "disk_unavailable", "磁盘用量统计失败，请重试或检查目录权限", nil)
				return
			}
			location := manager.cfg.Workspace
			if name == "appData" {
				location = manager.cfg.AppData
			}
			u.Total, u.Available, err = volumeSpace(location)
			if err != nil {
				u.VolumeError = "所在磁盘容量不可用"
			}
			values[name] = u
		}
		writeJSON(w, 200, values)
	}))
}
