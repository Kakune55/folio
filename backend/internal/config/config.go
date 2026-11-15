package config

import (
	"errors"
	"folio/internal/auth"
	"folio/internal/search"
	"folio/internal/storage"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	StorageBackend                                    string
	S3                                                storage.S3Options
	IndexLimit                                        int64
	TLSCert, TLSKey                                   string
	Addr, Workspace, AppData, InitialPassword, Origin string
	SecureCookie, DemoMode                            bool
	Limits                                            storage.Limits
}

func Load() (Config, error) {
	get := func(key, fallback string) string {
		if value := os.Getenv(key); value != "" {
			return value
		}
		return fallback
	}
	c := Config{Addr: get("FOLIO_ADDR", "127.0.0.1:8080"), Workspace: get("FOLIO_WORKSPACE", "./workspace"), AppData: get("FOLIO_APP_DATA", "./app-data"), Origin: os.Getenv("FOLIO_ORIGIN"), SecureCookie: true}
	c.StorageBackend = get("FOLIO_STORAGE_BACKEND", "local")
	if c.StorageBackend != "local" && c.StorageBackend != "s3" {
		return c, errors.New("FOLIO_STORAGE_BACKEND 必须为 local 或 s3")
	}
	if c.StorageBackend == "s3" {
		var e error
		c.S3, e = S3FromEnv()
		if e != nil {
			return c, e
		}
	}
	if raw := os.Getenv("FOLIO_DEMO_MODE"); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			return c, errors.New("FOLIO_DEMO_MODE 必须为 true 或 false")
		}
		c.DemoMode = value
	}
	if raw := os.Getenv("FOLIO_SECURE_COOKIE"); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			return c, errors.New("FOLIO_SECURE_COOKIE 必须为 true 或 false")
		}
		c.SecureCookie = value
	}
	if !c.SecureCookie {
		host, _, err := net.SplitHostPort(c.Addr)
		ip := net.ParseIP(host)
		if err != nil || ip == nil || !ip.IsLoopback() {
			return c, errors.New("非 HTTPS Cookie 仅允许绑定回环 IP")
		}
	}
	c.TLSCert = os.Getenv("FOLIO_TLS_CERT")
	c.TLSKey = os.Getenv("FOLIO_TLS_KEY")
	if (c.TLSCert == "") != (c.TLSKey == "") {
		return c, errors.New("FOLIO_TLS_CERT 和 FOLIO_TLS_KEY 必须同时配置")
	}
	if c.Origin != "" {
		origin, err := url.Parse(c.Origin)
		if err != nil || origin.Host == "" || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" || (origin.Scheme != "https" && origin.Scheme != "http") {
			return c, errors.New("FOLIO_ORIGIN 必须是没有路径的完整 HTTP(S) origin")
		}
		if c.SecureCookie && origin.Scheme != "https" {
			return c, errors.New("安全 Cookie 要求 HTTPS origin")
		}
	}
	directories := []string{c.AppData}
	if c.StorageBackend == "local" {
		directories = append(directories, c.Workspace)
	}
	for _, dir := range directories {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return c, err
		}
	}
	var err error
	if c.StorageBackend == "local" {
		c.Workspace, err = filepath.EvalSymlinks(c.Workspace)
		if err != nil {
			return c, err
		}
		c.Workspace, err = filepath.Abs(c.Workspace)
		if err != nil {
			return c, err
		}
	}
	c.AppData, err = filepath.EvalSymlinks(c.AppData)
	if err != nil {
		return c, err
	}
	c.AppData, err = filepath.Abs(c.AppData)
	if err != nil {
		return c, err
	}
	contains := func(parent, child string) bool {
		rel, err := filepath.Rel(parent, child)
		return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
	}
	if c.StorageBackend == "local" && (contains(c.Workspace, c.AppData) || contains(c.AppData, c.Workspace)) {
		return c, errors.New("工作区和应用数据目录必须分离，不能相互包含")
	}
	if file := os.Getenv("FOLIO_PASSWORD_FILE"); file != "" {
		password, err := auth.ReadPasswordFile(file)
		if err != nil {
			return c, err
		}
		c.InitialPassword = password
	}
	c.Limits = storage.DefaultLimits
	for key, target := range map[string]*int64{"FOLIO_MAX_TEXT_BYTES": &c.Limits.Text, "FOLIO_MAX_IMAGE_BYTES": &c.Limits.Image, "FOLIO_MAX_PDF_BYTES": &c.Limits.PDF, "FOLIO_MAX_ATTACHMENT_BYTES": &c.Limits.Attachment, "FOLIO_MAX_IMAGE_PIXELS": &c.Limits.ImagePixels} {
		if raw := os.Getenv(key); raw != "" {
			value, err := strconv.ParseInt(raw, 10, 64)
			if err != nil || value < 1 {
				return c, errors.New(key + " 必须是正整数")
			}
			*target = value
		}
	}
	c.IndexLimit = search.DefaultBodyLimit
	if raw := os.Getenv("FOLIO_MAX_INDEX_BYTES"); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value < 1 || value > 100<<20 {
			return c, errors.New("FOLIO_MAX_INDEX_BYTES 须为 1 字节到 100 MiB")
		}
		c.IndexLimit = value
	}
	return c, nil
}

func S3FromEnv() (storage.S3Options, error) {
	o := storage.S3Options{Bucket: os.Getenv("FOLIO_S3_BUCKET"), Prefix: os.Getenv("FOLIO_S3_PREFIX"), Endpoint: os.Getenv("FOLIO_S3_ENDPOINT"), Region: os.Getenv("FOLIO_S3_REGION"), AccessKey: os.Getenv("FOLIO_S3_ACCESS_KEY"), SecretKey: os.Getenv("FOLIO_S3_SECRET_KEY")}
	if o.Bucket == "" {
		return o, errors.New("S3 模式必须配置 FOLIO_S3_BUCKET")
	}
	if strings.TrimSpace(o.AccessKey) == "" || strings.TrimSpace(o.SecretKey) == "" {
		return o, errors.New("S3 模式必须配置 FOLIO_S3_ACCESS_KEY 和 FOLIO_S3_SECRET_KEY")
	}
	if o.Endpoint != "" {
		u, err := url.Parse(o.Endpoint)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || (u.Scheme != "http" && u.Scheme != "https") {
			return o, errors.New("FOLIO_S3_ENDPOINT 必须是合法 HTTP(S) 地址且不能包含路径、凭据或查询参数")
		}
	}
	if raw := os.Getenv("FOLIO_S3_PATH_STYLE"); raw != "" {
		v, err := strconv.ParseBool(raw)
		if err != nil {
			return o, errors.New("FOLIO_S3_PATH_STYLE 必须为 true 或 false")
		}
		o.PathStyle = v
	}
	return o, nil
}
