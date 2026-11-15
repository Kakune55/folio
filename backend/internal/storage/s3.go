package storage

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"image"
	"io"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// S3Options 只配置工作区对象存储；数据库和索引仍在本地。
type S3Options struct {
	Bucket, Prefix, Region, Endpoint string
	AccessKey, SecretKey             string
	PathStyle                        bool
}
type S3Backend struct {
	client     *minio.Client
	httpClient *http.Client
	opts       S3Options
	mu         sync.Mutex
	users      map[int64]*S3Store
}
type s3Object struct {
	Name, ETag string
	Size       int64
	Modified   time.Time
}

func NewS3(ctx context.Context, opts S3Options) (*S3Backend, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if opts.Bucket == "" {
		return nil, errors.New("S3 bucket 不能为空")
	}
	opts.Prefix = strings.Trim(opts.Prefix, "/")
	if opts.Prefix != "" && ValidPath(opts.Prefix, false) != nil {
		return nil, errors.New("S3 prefix 必须是安全的相对路径")
	}
	if opts.Region == "" {
		opts.Region = "us-east-1"
	}
	if strings.TrimSpace(opts.AccessKey) == "" || strings.TrimSpace(opts.SecretKey) == "" {
		return nil, errors.New("S3 必须显式配置 Access Key 和 Secret Key")
	}
	endpoint := opts.Endpoint
	if endpoint == "" {
		endpoint = "https://s3.amazonaws.com"
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, errors.New("S3 endpoint 必须是无路径、查询参数及凭据的 HTTP(S) 地址")
	}
	lookup := minio.BucketLookupAuto
	if opts.PathStyle {
		lookup = minio.BucketLookupPath
	}
	client, err := minio.New(u.Host, &minio.Options{Creds: credentials.NewStaticV4(opts.AccessKey, opts.SecretKey, ""), Secure: u.Scheme == "https", Region: opts.Region, BucketLookup: lookup, MaxRetries: 1})
	if err != nil {
		return nil, errors.New("S3 客户端配置无效，请检查 endpoint、地域及凭据格式")
	}
	return &S3Backend{client: client, httpClient: &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, opts: opts, users: map[int64]*S3Store{}}, nil
}
func (b *S3Backend) OpenUser(id int64) (Workspace, error) {
	if id <= 0 {
		return nil, fail("path_invalid")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if r := b.users[id]; r != nil {
		return r, nil
	}
	prefix := strconv.FormatInt(id, 10) + "/"
	if b.opts.Prefix != "" {
		prefix = b.opts.Prefix + "/" + prefix
	}
	r := &S3Store{backend: b, prefix: prefix, limits: DefaultLimits}
	// 只接受应用自己的布局标记，拒绝静默接管普通 .folio 对象。
	data, _, err := r.get(".folio/layout", 4096)
	if isCode(err, "not_found") {
		all, e := r.objects()
		if e != nil {
			return nil, e
		}
		for _, o := range all {
			if strings.HasPrefix(o.Name, ".folio/") {
				return nil, errors.New("S3 .folio 已存在且无有效布局标记，拒绝接管")
			}
		}
		identity := "s3:" + nonce()
		data, _ = json.Marshal(map[string]string{"format": "folio-s3-v1", "identity": identity})
		_, err = r.put(".folio/layout", data, "")
		if isCode(err, "target_exists") {
			data, _, err = r.get(".folio/layout", 4096)
		}
	}
	if err != nil {
		return nil, err
	}
	var marker map[string]string
	if json.Unmarshal(data, &marker) != nil || marker["format"] != "folio-s3-v1" || marker["identity"] == "" {
		return nil, errors.New("S3 布局标记无效，请检查目标前缀")
	}
	if marker["import"] == "pending" {
		return nil, errors.New("S3 导入尚未完成，请停服重试 -migrate-to-s3")
	}
	r.identity = marker["identity"]
	if err = r.probe(); err != nil {
		return nil, fmt.Errorf("S3 条件操作能力检查失败，拒绝写入：%w", err)
	}
	if err = r.recover(); err != nil {
		return nil, fmt.Errorf("S3 未完成操作恢复失败，原件保留；下次访问可重试：%w", err)
	}
	b.users[id] = r
	return r, nil
}
func nonce() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func isCode(err error, code string) bool { var e *Error; return errors.As(err, &e) && e.Code == code }
func s3Error(err error, create, write bool) error {
	if err == nil {
		return nil
	}
	api := minio.ToErrorResponse(err)
	if api.Code != "" {
		switch api.Code {
		case "NoSuchKey", "NotFound":
			return fail("not_found")
		case "PreconditionFailed", "ConditionalRequestConflict":
			if create {
				return fail("target_exists")
			}
			return fail("revision_conflict")
		case "NoSuchBucket":
			return fail("storage_unavailable")
		case "AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch":
			return fail("permission_denied")
		}
	}
	if write {
		return fail("durability_uncertain")
	}
	return fail("storage_unavailable")
}

// etag 保留标准双引号表示，兼容此前已持久化的操作记录。
func quotedETag(tag string) string {
	if tag == "" {
		return ""
	}
	return "\"" + strings.Trim(tag, "\"") + "\""
}
func (r *S3Store) get(name string, limit int64) ([]byte, s3Object, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	// 先取得元信息，再以同一 ETag 条件读取，接受额外请求以保持实现简单。
	info, err := r.backend.client.StatObject(ctx, r.backend.opts.Bucket, r.prefix+name, minio.StatObjectOptions{})
	if err != nil {
		return nil, s3Object{}, s3Error(err, false, false)
	}
	if info.Size > limit {
		return nil, s3Object{}, fail("too_large")
	}
	if info.ETag == "" {
		return nil, s3Object{}, fail("storage_unavailable")
	}
	options := minio.GetObjectOptions{Checksum: true}
	if err = options.SetMatchETag(strings.Trim(info.ETag, "\"")); err != nil {
		return nil, s3Object{}, fail("storage_unavailable")
	}
	reader, err := r.backend.client.GetObject(ctx, r.backend.opts.Bucket, r.prefix+name, options)
	if err != nil {
		return nil, s3Object{}, s3Error(err, false, false)
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, s3Object{}, s3Error(err, false, false)
	}
	if int64(len(data)) > limit {
		return nil, s3Object{}, fail("too_large")
	}
	if int64(len(data)) != info.Size {
		return nil, s3Object{}, fail("file_changed")
	}
	return data, s3Object{name, quotedETag(info.ETag), info.Size, info.LastModified}, nil
}

// expected 为空表示仅创建，否则必须匹配后端 ETag；禁止自动 multipart 和写入重试。
func (r *S3Store) put(name string, data []byte, expected string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	options := minio.PutObjectOptions{DisableMultipart: true, SendContentMd5: true}
	if expected == "" {
		options.SetMatchETagExcept("*")
	} else {
		options.SetMatchETag(strings.Trim(expected, "\""))
	}
	info, err := r.backend.client.PutObject(ctx, r.backend.opts.Bucket, r.prefix+name, bytes.NewReader(data), int64(len(data)), options)
	if err != nil {
		return "", s3Error(err, expected == "", true)
	}
	if info.ETag == "" {
		return "", fail("durability_uncertain")
	}
	return quotedETag(info.ETag), nil
}
func (r *S3Store) del(name, etag string) error {
	if etag == "" {
		return fail("precondition_required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	// minio-go v7 的 RemoveObjectOptions 不暴露 If-Match；用公开签名 API 保留条件删除语义。
	headers := http.Header{"If-Match": []string{etag}}
	signed, err := r.backend.client.PresignHeader(ctx, http.MethodDelete, r.backend.opts.Bucket, r.prefix+name, time.Minute, nil, headers)
	if err != nil {
		return s3Error(err, false, true)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodDelete, signed.String(), nil)
	if err != nil {
		return fail("storage_unavailable")
	}
	request.Header = headers
	response, err := r.backend.httpClient.Do(request)
	if err != nil {
		return fail("durability_uncertain")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent {
		return nil
	}
	var remote minio.ErrorResponse
	if xml.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&remote) != nil {
		return fail("durability_uncertain")
	}
	remote.StatusCode = response.StatusCode
	return s3Error(remote, false, true)
}
func (r *S3Store) objects() ([]s3Object, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	var result []s3Object
	for o := range r.backend.client.ListObjects(ctx, r.backend.opts.Bucket, minio.ListObjectsOptions{Prefix: r.prefix, Recursive: true, FetchOwner: boolPointer(false)}) {
		if o.Err != nil {
			return nil, s3Error(o.Err, false, false)
		}
		if !strings.HasPrefix(o.Key, r.prefix) {
			return nil, fail("path_invalid")
		}
		name := strings.TrimPrefix(o.Key, r.prefix)
		if name == "" {
			continue
		}
		if path.Clean(strings.TrimSuffix(name, "/")) != strings.TrimSuffix(name, "/") || strings.ContainsAny(name, "\\\x00") {
			return nil, fail("path_invalid")
		}
		result = append(result, s3Object{name, quotedETag(o.ETag), o.Size, o.LastModified})
	}
	if err := ctx.Err(); err != nil {
		return nil, fail("storage_unavailable")
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}
func boolPointer(value bool) *bool { return &value }
func (r *S3Store) probe() error {
	name := ".folio/probe-" + nonce()
	tag, err := r.put(name, []byte("probe"), "")
	if err != nil {
		return err
	}
	defer func() {
		data, info, e := r.get(name, 100)
		_ = data
		if e == nil {
			_ = r.del(name, info.ETag)
		}
	}()
	if _, e := r.put(name, []byte("bad"), ""); !isCode(e, "target_exists") {
		return errors.New("If-None-Match 未被可靠执行")
	}
	if _, e := r.put(name, []byte("bad"), "\"stale\""); !isCode(e, "revision_conflict") {
		return errors.New("If-Match 未被可靠执行")
	}
	if e := r.del(name, "\"stale\""); !isCode(e, "revision_conflict") {
		return errors.New("条件删除未被可靠执行")
	}
	data, _, err := r.get(name, 100)
	if err != nil || string(data) != "probe" {
		return errors.New("条件请求改变了原件")
	}
	_, err = r.put(name, []byte("confirmed"), tag)
	return err
}

// S3Store 每用户一把锁。所有读取、修改与内部载荷操作均串行，避免半完成目录可见。
type S3Store struct {
	mu               sync.Mutex
	backend          *S3Backend
	prefix, identity string
	limits           Limits
	quota            func() (int64, error)
	indexUsage       func() (int64, error)
	blocked          bool
}

func (r *S3Store) Identity() (string, error) { return r.identity, nil }
func (r *S3Store) Close() error              { return nil }
func (r *S3Store) SetLimits(l Limits) error {
	s := Store{}
	if err := s.SetLimits(l); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.limits = l
	return nil
}
func (r *S3Store) Limits() Limits { r.mu.Lock(); defer r.mu.Unlock(); return r.limits }
func (r *S3Store) SetIndexUsage(get func() (int64, error)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.indexUsage = get
}
func (r *S3Store) SetQuota(q func() (int64, error)) { r.mu.Lock(); defer r.mu.Unlock(); r.quota = q }
func (r *S3Store) ready() error {
	if r.blocked {
		return r.recover()
	}
	return nil
}
func public(name string) bool { return ValidPath(strings.TrimSuffix(name, "/"), false) == nil }
func (r *S3Store) tree() (map[string]s3Object, error) {
	all, err := r.objects()
	if err != nil {
		return nil, err
	}
	nodes := map[string]s3Object{"": {Name: "/"}}
	for _, o := range all {
		if !public(o.Name) {
			continue
		}
		name := strings.TrimSuffix(o.Name, "/")
		if strings.HasSuffix(o.Name, "/") && o.Size != 0 {
			return nil, fail("unsupported_file_type")
		}
		if old, ok := nodes[name]; ok && strings.HasSuffix(old.Name, "/") != strings.HasSuffix(o.Name, "/") {
			return nil, fail("unsupported_file_type")
		}
		nodes[name] = o
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if old, ok := nodes[parent]; ok && !strings.HasSuffix(old.Name, "/") {
				return nil, fail("not_a_directory")
			}
			if _, ok := nodes[parent]; !ok {
				nodes[parent] = s3Object{Name: parent + "/"}
			}
		}
	}
	return nodes, nil
}
func (r *S3Store) parent(nodes map[string]s3Object, name string) error {
	p := path.Dir(name)
	if p == "." {
		return nil
	}
	o, ok := nodes[p]
	if !ok {
		return fail("not_found")
	}
	if !strings.HasSuffix(o.Name, "/") {
		return fail("not_a_directory")
	}
	return nil
}
func (r *S3Store) List(name string, offset, limit int) ([]Entry, int, error) {
	if err := ValidPath(name, true); err != nil {
		return nil, 0, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(); err != nil {
		return nil, 0, err
	}
	nodes, err := r.tree()
	if err != nil {
		return nil, 0, err
	}
	o, ok := nodes[name]
	if !ok {
		return nil, 0, fail("not_found")
	}
	if !strings.HasSuffix(o.Name, "/") {
		return nil, 0, fail("not_a_directory")
	}
	var out []Entry
	for key, node := range nodes {
		if key == "" {
			continue
		}
		p := path.Dir(key)
		if p == "." {
			p = ""
		}
		if p != name {
			continue
		}
		kind := "file"
		if strings.HasSuffix(node.Name, "/") {
			kind = "directory"
		}
		out = append(out, Entry{path.Base(key), key, kind, node.Size})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind == "directory"
		}
		return out[i].Name < out[j].Name
	})
	n := len(out)
	offset = min(max(offset, 0), n)
	return out[offset:min(offset+max(limit, 0), n)], n, nil
}
func (r *S3Store) Mkdir(name string) error {
	if err := ValidPath(name, false); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(); err != nil {
		return err
	}
	nodes, err := r.tree()
	if err != nil {
		return err
	}
	if _, ok := nodes[name]; ok {
		return fail("target_exists")
	}
	if err = r.parent(nodes, name); err != nil {
		return err
	}
	_, err = r.put(name+"/", nil, "")
	return err
}
func textBytes(data []byte) error {
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return fail("unsupported_file_type")
	}
	return nil
}
func (r *S3Store) Read(name string) (*Content, error) {
	if err := ValidPath(name, false); err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(); err != nil {
		return nil, err
	}
	data, o, err := r.get(name, r.limits.Text)
	if err != nil {
		return nil, err
	}
	if err = textBytes(data); err != nil {
		return nil, err
	}
	return &Content{Path: name, Kind: "text", Content: string(data), Encoding: "utf-8", Revision: digest(data), Size: o.Size, Mtime: o.Modified.UTC().Format(time.RFC3339Nano)}, nil
}
func (r *S3Store) usageLocked() (Usage, error) {
	all, err := r.objects()
	if err != nil {
		return Usage{}, err
	}
	var u Usage
	for _, o := range all {
		if strings.HasSuffix(o.Name, "/") {
			continue
		}
		if public(o.Name) || strings.HasPrefix(o.Name, ".folio/shares/") || strings.Contains(o.Name, "/payload/") || strings.HasSuffix(o.Name, "/payload") {
			u.Used += o.Size
		}
	}
	if r.quota != nil {
		u.Quota, err = r.quota()
	}
	if err == nil && r.indexUsage != nil {
		var n int64
		n, err = r.indexUsage()
		u.Used += n
	}
	return u, err
}
func (r *S3Store) checkQuota(n int64) error {
	if n <= 0 || r.quota == nil {
		return nil
	}
	u, err := r.usageLocked()
	if err != nil {
		return err
	}
	if n > u.Quota-u.Used {
		return fail("quota_exceeded")
	}
	return nil
}
func (r *S3Store) Usage() (Usage, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(); err != nil {
		return Usage{}, err
	}
	return r.usageLocked()
}
func (r *S3Store) write(name string, data []byte, revision string, create bool) (string, error) {
	nodes, err := r.tree()
	if err != nil {
		return "", err
	}
	if err = r.parent(nodes, name); err != nil {
		return "", err
	}
	expected := ""
	oldSize := int64(0)
	if create {
		if _, ok := nodes[name]; ok {
			return "", fail("target_exists")
		}
	} else {
		if revision == "" {
			return "", fail("precondition_required")
		}
		old, o, e := r.get(name, r.limits.Attachment)
		if e != nil {
			return "", e
		}
		if digest(old) != revision {
			return "", &Error{Code: "revision_conflict", Revision: digest(old)}
		}
		expected = o.ETag
		oldSize = o.Size
	}
	if err = r.checkQuota(int64(len(data)) - oldSize); err != nil {
		return "", err
	}
	_, err = r.put(name, data, expected)
	if err != nil {
		return "", err
	}
	return digest(data), nil
}
func (r *S3Store) Write(name, source, revision string, create bool) (string, error) {
	if err := ValidPath(name, false); err != nil {
		return "", err
	}
	data := []byte(source)
	if err := textBytes(data); err != nil {
		return "", err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(); err != nil {
		return "", err
	}
	if int64(len(data)) > r.limits.Text {
		return "", fail("too_large")
	}
	return r.write(name, data, revision, create)
}

// 有界内存快照是第一版的明确取舍，不对外暴露本地临时文件或 S3 句柄。
type memoryDownload struct{ *bytes.Reader }

func (memoryDownload) Close() error { return nil }
func metadataBytes(name string, data []byte, mtime time.Time, l Limits) (*Metadata, error) {
	// 复用本地格式识别规则的纯字节版本。
	m := &Metadata{Path: name, Size: int64(len(data)), MediaType: "application/octet-stream", Viewer: "binary", Mtime: mtime.UTC().Format(time.RFC3339Nano)}
	ext := strings.ToLower(path.Ext(name))
	active := ext == ".svg" || ext == ".html" || ext == ".htm"
	if !active && int64(len(data)) <= l.Image && imageType(data) != "" {
		cfg, err := decodeImageConfig(data)
		if err == nil && cfg[0] > 0 && cfg[1] > 0 && int64(cfg[0]) <= l.ImagePixels/int64(cfg[1]) {
			m.Viewer = "image"
			m.MediaType = imageType(data)
			return m, nil
		}
	}
	if !active && bytes.HasPrefix(data, []byte("%PDF-")) && int64(len(data)) <= l.PDF {
		m.Viewer = "pdf"
		m.MediaType = "application/pdf"
		return m, nil
	}
	if int64(len(data)) <= l.Text && textBytes(data) == nil {
		m.Viewer = "text"
		m.MediaType = "text/plain"
		if ext == ".md" || ext == ".markdown" {
			m.Viewer = "markdown"
			m.MediaType = "text/markdown"
		}
	}
	return m, nil
}
func (r *S3Store) ReadDownload(name string, preview bool, maxBytes int64) (*Download, *Metadata, error) {
	if err := ValidPath(name, false); err != nil {
		return nil, nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(); err != nil {
		return nil, nil, err
	}
	data, o, err := r.get(name, min(maxBytes, r.limits.Attachment))
	if err != nil {
		return nil, nil, err
	}
	m, err := metadataBytes(name, data, o.Modified, r.limits)
	if err != nil {
		return nil, nil, err
	}
	if preview && m.Viewer != "image" && m.Viewer != "pdf" {
		return nil, nil, fail("preview_unavailable")
	}
	return &Download{memoryDownload{bytes.NewReader(data)}, digest(data)}, m, nil
}
func (r *S3Store) Metadata(name string) (*Metadata, error) {
	f, m, err := r.ReadDownload(name, false, r.Limits().Attachment)
	if f != nil {
		f.Close()
	}
	return m, err
}
func (r *S3Store) Upload(dir, name string, reader io.Reader, imageOnly bool) (*Metadata, error) {
	m, _, err := r.UploadConditional(dir, name, reader, imageOnly, "", true)
	return m, err
}
func (r *S3Store) UploadConditional(dir, name string, reader io.Reader, imageOnly bool, revision string, create bool) (*Metadata, string, error) {
	if ValidPath(dir, true) != nil || strings.Contains(name, "/") {
		return nil, "", fail("path_invalid")
	}
	full := name
	if dir != "" {
		full = dir + "/" + name
	}
	if err := ValidPath(full, false); err != nil {
		return nil, "", err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(); err != nil {
		return nil, "", err
	}
	data, err := io.ReadAll(io.LimitReader(reader, r.limits.Attachment+1))
	if err != nil {
		return nil, "", err
	}
	if int64(len(data)) > r.limits.Attachment {
		return nil, "", fail("too_large")
	}
	ext := strings.ToLower(path.Ext(name))
	image := imageType(data) != "" || ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".webp" || ext == ".gif"
	pdf := bytes.HasPrefix(data, []byte("%PDF-")) || ext == ".pdf"
	if image && int64(len(data)) > r.limits.Image || pdf && int64(len(data)) > r.limits.PDF {
		return nil, "", fail("too_large")
	}
	m, err := metadataBytes(full, data, time.Now().UTC(), r.limits)
	if err != nil {
		return nil, "", err
	}
	if imageOnly && m.Viewer != "image" {
		return nil, "", fail("preview_unavailable")
	}
	rev, err := r.write(full, data, revision, create)
	return m, rev, err
}
func (r *S3Store) revision(nodes map[string]s3Object, name string) (string, string, error) {
	o, ok := nodes[name]
	if !ok {
		return "", "", fail("not_found")
	}
	if !strings.HasSuffix(o.Name, "/") {
		data, _, err := r.get(name, r.limits.Attachment)
		return digest(data), "file", err
	}
	var keys []string
	for k := range nodes {
		if path.Dir(k) == name {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString("directory\x00")
	for _, k := range keys {
		rev, kind, err := r.revision(nodes, k)
		if err != nil {
			return "", "", err
		}
		fmt.Fprintf(&b, "%d:%s\x00%s\x00%s\x00", len(path.Base(k)), path.Base(k), kind, rev)
	}
	return digest([]byte(b.String())), "directory", nil
}
func (r *S3Store) EntryRevision(name string) (*EntryRevision, error) {
	if err := ValidPath(name, false); err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(); err != nil {
		return nil, err
	}
	nodes, err := r.tree()
	if err != nil {
		return nil, err
	}
	rev, kind, err := r.revision(nodes, name)
	return &EntryRevision{name, kind, rev}, err
}
func (r *S3Store) Patch(name, diff, revision string, dryRun bool) (*PatchResult, error) {
	return patchWorkspace(r, name, diff, revision, dryRun)
}
func (r *S3Store) Scan(ctx context.Context, visit func(IndexEntry) error) error {
	return r.ScanPath(ctx, "", visit)
}
func (r *S3Store) ScanPath(ctx context.Context, target string, visit func(IndexEntry) error) error {
	if err := ValidPath(target, true); err != nil {
		return err
	}
	entries, err := func() ([]IndexEntry, error) {
		r.mu.Lock()
		defer r.mu.Unlock()
		if err := r.ready(); err != nil {
			return nil, err
		}
		all, err := r.objects()
		if err != nil {
			return nil, err
		}
		var result []IndexEntry
		for _, o := range all {
			if err = ctx.Err(); err != nil {
				return nil, err
			}
			if !public(o.Name) || strings.HasSuffix(o.Name, "/") || target != "" && o.Name != target && !strings.HasPrefix(o.Name, target+"/") {
				continue
			}
			stamp := o.ETag
			if o.Size <= TextLimit {
				data, _, e := r.get(o.Name, TextLimit)
				if e != nil {
					return nil, e
				}
				stamp = digest(data)
			}
			result = append(result, IndexEntry{o.Name, stamp, o.Size})
		}
		return result, nil
	}()
	if err != nil {
		return err
	}
	// 回调可能重新读取正文，不能在用户锁内调用；读取仍核对捕获的版本。
	for _, entry := range entries {
		if err = ctx.Err(); err != nil {
			return err
		}
		if err = visit(entry); err != nil {
			return err
		}
	}
	return nil
}
func (r *S3Store) ReadIndexText(name, stamp string, limit int64) (string, error) {
	if err := ValidPath(name, false); err != nil {
		return "", err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(); err != nil {
		return "", err
	}
	data, info, err := r.get(name, limit)
	if isCode(err, "too_large") {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	actual := digest(data)
	if int64(len(data)) > TextLimit {
		actual = info.ETag
	}
	if actual != stamp {
		return "", fail("file_changed")
	}
	if textBytes(data) != nil || imageType(data) != "" || bytes.HasPrefix(data, []byte("%PDF-")) || strings.EqualFold(path.Ext(name), ".pdf") {
		return "", nil
	}
	return string(data), nil
}
func (r *S3Store) IndexFileSize(name string) (int64, error) {
	if err := ValidPath(name, false); err != nil {
		return 0, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(); err != nil {
		return 0, err
	}
	all, err := r.objects()
	for _, o := range all {
		if o.Name == name {
			return o.Size, err
		}
	}
	if err != nil {
		return 0, err
	}
	return 0, fail("not_found")
}
func (r *S3Store) readBundle(prefix string, files []BundleFile) ([]BundleFile, error) {
	if len(files) == 0 || len(files) > BundleFileLimit {
		return nil, fail("too_large")
	}
	seen := map[string]bool{}
	var out []BundleFile
	var total int64
	for _, f := range files {
		if ValidPath(f.Path, false) != nil || seen[f.Path] {
			return nil, fail("path_invalid")
		}
		seen[f.Path] = true
		data, o, err := r.get(prefix+f.Path, min(BundleLimit-total, r.limits.Attachment))
		if err != nil {
			return nil, err
		}
		rev := digest(data)
		if f.Revision != "" && f.Revision != rev {
			return nil, fail("revision_conflict")
		}
		m, err := metadataBytes(f.Path, data, o.Modified, r.limits)
		if err != nil {
			return nil, err
		}
		out = append(out, BundleFile{f.Path, rev, m, data})
		total += int64(len(data))
	}
	return out, nil
}
func (r *S3Store) ReadBundle(files []BundleFile) ([]BundleFile, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(); err != nil {
		return nil, err
	}
	return r.readBundle("", files)
}
func (r *S3Store) SnapshotUsage() (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	all, err := r.objects()
	var n int64
	for _, o := range all {
		if strings.HasPrefix(o.Name, ".folio/shares/") {
			n += o.Size
		}
	}
	return n, err
}
func (r *S3Store) ReadSnapshot(name string, files []BundleFile) ([]BundleFile, error) {
	if err := snapshotName(name); err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(); err != nil {
		return nil, err
	}
	return r.readBundle(".folio/shares/"+name+"/", files)
}
func (r *S3Store) removePrefix(prefix string) error {
	all, err := r.objects()
	if err != nil {
		return err
	}
	for _, o := range all {
		if strings.HasPrefix(o.Name, prefix) {
			if err = r.del(o.Name, o.ETag); err != nil {
				return err
			}
		}
	}
	return nil
}
func (r *S3Store) RemoveSnapshot(name string) error {
	if err := snapshotName(name); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(); err != nil {
		return err
	}
	return r.removePrefix(".folio/shares/" + name + "/")
}
func (r *S3Store) PublishSnapshot(name string, files []BundleFile, commit func() error) error {
	if err := snapshotName(name); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(); err != nil {
		return err
	}
	for _, selected := range files {
		if ValidPath(selected.Path, false) != nil {
			return fail("path_invalid")
		}
		data, _, err := r.get(selected.Path, r.limits.Attachment)
		if err != nil {
			return err
		}
		if selected.Revision == "" || digest(data) != selected.Revision || digest(selected.Data) != selected.Revision {
			return fail("revision_conflict")
		}
	}
	if err := r.publish(".folio/shares/"+name, files); err != nil {
		return err
	}
	return commit()
}
func (r *S3Store) publish(destination string, files []BundleFile) error {
	if len(files) == 0 || len(files) > BundleFileLimit {
		return fail("too_large")
	}
	var n int64
	seen := map[string]bool{}
	for _, f := range files {
		if ValidPath(f.Path, false) != nil || seen[f.Path] {
			return fail("path_invalid")
		}
		seen[f.Path] = true
		n += int64(len(f.Data))
		m, _ := metadataBytes(f.Path, f.Data, time.Time{}, r.limits)
		limit := r.limits.Attachment
		if m.Viewer == "image" {
			limit = min(limit, r.limits.Image)
		}
		if m.Viewer == "pdf" {
			limit = min(limit, r.limits.PDF)
		}
		if int64(len(f.Data)) > limit {
			return fail("too_large")
		}
	}
	for name := range seen {
		for p := path.Dir(name); p != "."; p = path.Dir(p) {
			if seen[p] {
				return fail("path_invalid")
			}
		}
	}
	if n > BundleLimit {
		return fail("too_large")
	}
	if err := r.checkQuota(n); err != nil {
		return err
	}
	all, err := r.objects()
	if err != nil {
		return err
	}
	for _, o := range all {
		if o.Name == destination || strings.HasPrefix(o.Name, destination+"/") {
			return fail("target_exists")
		}
	}
	op := s3Operation{ID: nonce(), Kind: "publish", TargetPrefix: destination}
	op.SourcePrefix = ".folio/staging/" + op.ID
	for _, f := range files {
		op.Items = append(op.Items, s3Item{Target: destination + "/" + f.Path, Hash: digest(f.Data)})
	}
	// 先把完整候选写入私有暂存前缀；恢复日志发布后才能对外复制。
	for i, f := range files {
		source := ".folio/staging/" + op.ID + "/" + strconv.Itoa(i)
		tag, e := r.put(source, f.Data, "")
		if e != nil {
			return e
		}
		op.Items[i].Source = source
		op.Items[i].SourceETag = tag
	}
	return r.run(op)
}
func (r *S3Store) ImportBundle(dir string, files []BundleFile) (string, error) {
	if err := ValidPath(dir, false); err != nil {
		return "", err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(); err != nil {
		return "", err
	}
	nodes, err := r.tree()
	if err != nil {
		return "", err
	}
	if _, ok := nodes[dir]; ok {
		return "", fail("target_exists")
	}
	if err = r.parent(nodes, dir); err != nil {
		return "", err
	}
	if err = r.publish(dir, files); err != nil {
		return "", err
	}
	return dir, nil
}
func (r *S3Store) StorageDetails(ctx context.Context) (StorageBreakdown, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(); err != nil {
		return StorageBreakdown{}, err
	}
	all, err := r.objects()
	if err != nil {
		return StorageBreakdown{}, err
	}
	v := map[string]int64{}
	var out StorageBreakdown
	for _, o := range all {
		if err = ctx.Err(); err != nil {
			return out, err
		}
		if strings.HasSuffix(o.Name, "/") {
			continue
		}
		key := "other"
		switch {
		case strings.HasPrefix(o.Name, ".folio/shares/"):
			key = "shares"
		case strings.HasPrefix(o.Name, ".folio/trash/") && (strings.Contains(o.Name, "/payload/") || strings.HasSuffix(o.Name, "/payload")):
			key = "trash"
		case public(o.Name):
			switch strings.ToLower(path.Ext(o.Name)) {
			case ".md", ".markdown", ".txt", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".csv", ".rtf", ".odt":
				key = "documents"
			case ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif", ".heic", ".bmp", ".ico", ".tif", ".tiff":
				key = "images"
			case ".mp3", ".mp4", ".m4a", ".mov", ".wav", ".ogg", ".flac", ".webm", ".mkv", ".aac":
				key = "media"
			}
		default:
			continue
		}
		v[key] += o.Size
	}
	if r.indexUsage != nil {
		n, e := r.indexUsage()
		if e != nil {
			return StorageBreakdown{}, e
		}
		v["index"] = n
	}
	for _, key := range []string{"documents", "images", "media", "other", "trash", "shares", "index"} {
		out.Categories = append(out.Categories, StorageCategory{key, v[key]})
		out.Used += v[key]
	}
	if r.quota != nil {
		out.Quota, err = r.quota()
	}
	return out, err
}

func decodeImageConfig(data []byte) ([2]int, error) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	return [2]int{cfg.Width, cfg.Height}, err
}
