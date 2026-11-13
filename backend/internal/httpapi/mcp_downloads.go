package httpapi

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"folio/internal/auth"
	"folio/internal/fileio"
	"folio/internal/storage"
)

const mcpDownloadLimit = 100 << 20

type mcpDownloadTicket struct {
	accessTokenID int64
	ownerID       int64
	workspaceID   string
	path          string
	revision      string
	expiresAt     time.Time
}

type mcpDownloads struct {
	auth      *auth.Service
	workspace func(int64) (*storage.Store, string, error)
	mu        sync.Mutex
	tickets   map[[32]byte]mcpDownloadTicket
	now       func() time.Time
}

func newMCPDownloads(authService *auth.Service, workspace func(ownerID int64) (*storage.Store, string, error)) *mcpDownloads {
	return &mcpDownloads{auth: authService, workspace: workspace, tickets: make(map[[32]byte]mcpDownloadTicket), now: time.Now}
}

func (s *mcpDownloads) clean(now time.Time) {
	for key, ticket := range s.tickets {
		if !now.Before(ticket.expiresAt) {
			delete(s.tickets, key)
		}
	}
}

func downloadOrigin(origin string) (string, error) {
	u, err := url.Parse(origin)
	if err != nil || u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.Hostname() == "" || u.User != nil || u.Opaque != "" || u.Path != "" || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.ContainsAny(origin, "?#\\\r\n\t ") {
		return "", mcpInputProblem("delivery", "configured_origin", "URL 下载需要配置合法的 http(s) 站点 Origin（不含路径、用户信息、查询或片段）；请使用 delivery=inline")
	}
	if port := u.Port(); port != "" || strings.HasSuffix(u.Host, ":") {
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return "", mcpInputProblem("delivery", "configured_origin", "URL 下载的站点 Origin 端口不合法；请修正配置或使用 delivery=inline")
		}
	}
	return u.String(), nil
}

func (s *mcpDownloads) validate(ownerID, tokenID int64, workspaceID string) (*storage.Store, error) {
	if s.auth == nil || s.workspace == nil {
		return nil, &mcpProblem{status: 503, code: "workspace_unavailable", message: "下载服务暂时不可用，请使用 inline 或稍后重试"}
	}
	p, access, err := s.auth.ValidateAccessTokenID(tokenID)
	if err != nil {
		if errors.Is(err, auth.ErrCredentials) {
			return nil, &mcpProblem{status: 401, code: "unauthenticated", message: "下载绑定的访问令牌无效、已过期或已撤销"}
		}
		return nil, &mcpProblem{status: 503, code: "internal_error", message: "认证服务暂时不可用"}
	}
	if p.ID != ownerID || access.WorkspaceID != workspaceID || (access.Permissions.Files != "read" && access.Permissions.Files != "write") {
		return nil, &storage.Error{Code: "forbidden"}
	}
	store, currentID, err := s.workspace(ownerID)
	if err != nil || store == nil {
		return nil, &mcpProblem{status: 503, code: "workspace_unavailable", message: "工作区暂时不可用"}
	}
	if currentID != workspaceID {
		return nil, &storage.Error{Code: "forbidden"}
	}
	return store, nil
}

func (s *mcpDownloads) issue(origin string, ownerID int64, access *auth.AccessToken, name string) (map[string]any, error) {
	origin, err := downloadOrigin(origin)
	if err != nil {
		return nil, err
	}
	if access == nil {
		return nil, &storage.Error{Code: "forbidden"}
	}
	store, err := s.validate(ownerID, access.ID, access.WorkspaceID)
	if err != nil {
		return nil, err
	}
	file, metadata, revision, err := openMCPDownload(store, name, mcpDownloadLimit)
	if err != nil {
		return nil, err
	}
	file.Close()
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, &mcpProblem{status: 500, code: "internal_error", message: "无法生成下载票据，请重试或使用 inline"}
	}
	secret := base64.RawURLEncoding.EncodeToString(nonce[:])
	key := sha256.Sum256([]byte(secret))
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.clean(now)
	if len(s.tickets) >= 128 {
		return nil, &mcpProblem{status: 429, code: "too_large", message: "待兑付下载票据已达上限，请使用 inline 或等待票据过期"}
	}
	expires := now.Add(60 * time.Second)
	if access.ExpiresAt != 0 && time.Unix(access.ExpiresAt, 0).Before(expires) {
		expires = time.Unix(access.ExpiresAt, 0)
	}
	s.tickets[key] = mcpDownloadTicket{access.ID, ownerID, access.WorkspaceID, name, revision, expires}
	return map[string]any{"url": origin + "/api/v1/public/mcp-download/" + secret, "path": name, "revision": revision, "size": metadata.Size, "mediaType": metadata.MediaType, "expiresAt": expires.Unix()}, nil
}

// openMCPDownload 返回同一个安全描述符及其原始字节版本，成功时位于文件开头，由调用者关闭。
func openMCPDownload(store *storage.Store, name string, maxBytes int64) (file *os.File, metadata *storage.Metadata, revision string, err error) {
	maxBytes = min(maxBytes, store.Limits().Attachment, int64(mcpDownloadLimit))
	file, metadata, err = store.OpenDownload(name, false)
	if err != nil {
		return nil, nil, "", downloadReadError(err)
	}
	defer func() {
		if err != nil {
			file.Close()
			file = nil
			metadata = nil
		}
	}()
	if err = fileio.CheckSingleLink(file); err != nil {
		return file, metadata, "", &storage.Error{Code: "unsupported_file_type"}
	}
	before, err := file.Stat()
	if err != nil {
		return file, metadata, "", downloadReadError(err)
	}
	if !before.Mode().IsRegular() {
		return file, metadata, "", &storage.Error{Code: "forbidden"}
	}
	if maxBytes < 0 || before.Size() > maxBytes || metadata.Size > maxBytes {
		return file, metadata, "", &storage.Error{Code: "too_large"}
	}
	hash := sha256.New()
	count, err := io.Copy(hash, io.LimitReader(file, maxBytes+1))
	if err != nil {
		return file, metadata, "", downloadReadError(err)
	}
	if count > maxBytes {
		return file, metadata, "", &storage.Error{Code: "too_large"}
	}
	after, err := file.Stat()
	if err != nil {
		return file, metadata, "", downloadReadError(err)
	}
	if err = fileio.CheckSingleLink(file); err != nil {
		return file, metadata, "", &storage.Error{Code: "unsupported_file_type"}
	}
	if !after.Mode().IsRegular() || !os.SameFile(before, after) || before.Size() != after.Size() || before.ModTime() != after.ModTime() || before.Mode() != after.Mode() || count != before.Size() || metadata.Size != count || metadata.Mtime != before.ModTime().UTC().Format(time.RFC3339Nano) {
		return file, metadata, "", &storage.Error{Code: "file_changed"}
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return file, metadata, "", downloadReadError(err)
	}
	return file, metadata, "sha256:" + hex.EncodeToString(hash.Sum(nil)), nil
}

func downloadReadError(err error) error {
	var problem *storage.Error
	if errors.As(err, &problem) {
		return &storage.Error{Code: problem.Code}
	}
	return &mcpProblem{status: 500, code: "internal_error", message: "文件读取失败，请稍后重试"}
}

func (s *mcpDownloads) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	fail := func(err error) {
		var problem *mcpProblem
		if errors.As(err, &problem) {
			details := problem.details
			if details == nil {
				details = map[string]any{}
			}
			writeError(w, problem.status, problem.code, problem.message, details)
		} else {
			storageError(w, err)
		}
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		fail(&mcpProblem{status: 405, code: "invalid_request", message: "下载仅接受 GET；HEAD 不会消费票据"})
		return
	}
	if len(r.Header.Values("Range")) != 0 {
		fail(&mcpProblem{status: 400, code: "invalid_request", message: "单次下载不支持 Range，请发送完整 GET"})
		return
	}
	secret := r.PathValue("ticket")
	if len(secret) != 43 {
		fail(&storage.Error{Code: "not_found"})
		return
	}
	key := sha256.Sum256([]byte(secret))
	s.mu.Lock()
	now := s.now()
	s.clean(now)
	ticket, ok := s.tickets[key]
	delete(s.tickets, key)
	s.mu.Unlock()
	if !ok {
		fail(&storage.Error{Code: "not_found"})
		return
	}
	store, err := s.validate(ticket.ownerID, ticket.accessTokenID, ticket.workspaceID)
	if err != nil {
		fail(err)
		return
	}
	file, metadata, revision, err := openMCPDownload(store, ticket.path, mcpDownloadLimit)
	if err != nil {
		fail(err)
		return
	}
	defer file.Close()
	if revision != ticket.revision {
		fail(&storage.Error{Code: "revision_conflict", Revision: revision})
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": path.Base(ticket.path)}))
	// 单次票据不使用条件缓存；SectionReader 防止外部增长写突破已校验的字节上限。
	r = r.Clone(r.Context())
	for _, name := range []string{"If-Match", "If-None-Match", "If-Modified-Since", "If-Unmodified-Since", "If-Range"} {
		r.Header.Del(name)
	}
	http.ServeContent(w, r, "", time.Time{}, io.NewSectionReader(file, 0, metadata.Size))
}
