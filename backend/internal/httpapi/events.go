package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"
)

type workspaceChange struct {
	Paths  []string      `json:"paths,omitempty"`
	Reset  bool          `json:"reset,omitempty"`
	Source *changeSource `json:"source,omitempty"`
}

// 仅保存鉴权后的名称，不将凭据或其他令牌元数据传入通知层。
type changeSource struct {
	Name string `json:"name"`
}
type changeSourceKey struct{}

func requestSource(r *http.Request) *changeSource {
	source, _ := r.Context().Value(changeSourceKey{}).(changeSource)
	if source.Name == "" {
		return nil
	}
	return &source
}

func withChangeSource(r *http.Request, name string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), changeSourceKey{}, changeSource{Name: name}))
}

type changeHub struct {
	mu          sync.Mutex
	subscribers map[chan workspaceChange]struct{}
	done        chan struct{}
	closed      bool
}

func newChangeHub() *changeHub {
	return &changeHub{subscribers: make(map[chan workspaceChange]struct{}), done: make(chan struct{})}
}
func (h *changeHub) subscribe() (chan workspaceChange, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil, errors.New("通知服务已停止")
	}
	if len(h.subscribers) >= 4 {
		return nil, errors.New("当前账号最多同时连接 4 个实时通知页面")
	}
	channel := make(chan workspaceChange, 1)
	h.subscribers[channel] = struct{}{}
	return channel, nil
}
func (h *changeHub) unsubscribe(channel chan workspaceChange) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.subscribers, channel)
}
func (h *changeHub) publish(source *changeSource, paths ...string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	change := workspaceChange{Paths: append([]string(nil), paths...), Reset: len(paths) == 0}
	if !change.Reset && source != nil {
		change.Source = &changeSource{Name: source.Name}
	}
	for channel := range h.subscribers {
		select {
		case channel <- change:
		default:
			// 慢连接只保留一次完整核对提示，不积累路径或丢失“需重新核对”语义。
			select {
			case <-channel:
			default:
			}
			channel <- workspaceChange{Reset: true}
		}
	}
}
func (h *changeHub) close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.closed {
		h.closed = true
		close(h.done)
	}
}
func (a *Accounts) StopEvents() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.eventsStopped = true
	for _, entry := range a.entries {
		if entry.events != nil {
			entry.events.close()
		}
	}
}

func (a *api) registerEvents(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/workspace/events", a.protect(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			w.Header().Set("Allow", "GET")
			writeError(w, 405, "method_not_allowed", "实时通知仅支持 GET", nil)
			return
		}
		if !a.allowedOrigin(r) {
			writeError(w, 403, "forbidden", "实时通知来源不被允许", nil)
			return
		}
		if a.Events == nil {
			writeError(w, 503, "events_unavailable", "实时通知暂不可用，请使用文件版本检查", nil)
			return
		}
		channel, err := a.Events.subscribe()
		if err != nil {
			w.Header().Set("Retry-After", "10")
			writeError(w, 429, "events_limit", err.Error(), nil)
			return
		}
		defer a.Events.unsubscribe(channel)
		control := http.NewResponseController(w)
		if err = control.SetWriteDeadline(time.Time{}); err != nil {
			writeError(w, 500, "events_unavailable", "无法启用实时通知连接，请使用文件版本检查", nil)
			return
		}
		defer control.SetWriteDeadline(time.Time{})
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("X-Accel-Buffering", "no")
		send := func(event string, change workspaceChange) bool {
			if err := control.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
				return false
			}
			if event == "" {
				_, err = fmt.Fprint(w, ": keepalive\n\n")
			} else {
				var data []byte
				data, err = json.Marshal(change)
				if err == nil {
					_, err = fmt.Fprintf(w, "retry: 2000\nevent: %s\ndata: %s\n\n", event, data)
				}
			}
			if err != nil || control.Flush() != nil {
				return false
			}
			return control.SetWriteDeadline(time.Time{}) == nil
		}
		valid := func() bool {
			p, err := a.Auth.Authenticate(sessionToken(r))
			return err == nil && (a.OwnerID == 0 || p.ID == a.OwnerID)
		}
		if !send("resync", workspaceChange{Reset: true}) {
			return
		}
		heartbeat := time.NewTicker(15 * time.Second)
		defer heartbeat.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-a.Events.done:
				return
			case change := <-channel:
				if !valid() {
					send("auth", workspaceChange{})
					return
				}
				if !send("change", change) {
					return
				}
			case <-heartbeat.C:
				if !valid() {
					send("auth", workspaceChange{})
					return
				}
				if !send("", workspaceChange{}) {
					return
				}
			}
		}
	}))
}
