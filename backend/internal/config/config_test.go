package config

import (
	"path/filepath"
	"testing"
)

func TestTLSConfigurationRequiresPairAndHTTPSOrigin(t *testing.T) {
	t.Setenv("FOLIO_WORKSPACE", filepath.Join(t.TempDir(), "workspace"))
	t.Setenv("FOLIO_APP_DATA", filepath.Join(t.TempDir(), "data"))
	t.Setenv("FOLIO_PASSWORD_FILE", "")
	t.Setenv("FOLIO_SECURE_COOKIE", "true")
	t.Setenv("FOLIO_MAX_INDEX_BYTES", "")
	t.Setenv("FOLIO_TLS_CERT", "cert.pem")
	t.Setenv("FOLIO_TLS_KEY", "")
	if _, err := Load(); err == nil {
		t.Fatal("缺少私钥未拒绝启动")
	}
	t.Setenv("FOLIO_TLS_KEY", "key.pem")
	t.Setenv("FOLIO_ORIGIN", "http://notes.example")
	if _, err := Load(); err == nil {
		t.Fatal("安全 Cookie 配置了非 HTTPS origin")
	}
	t.Setenv("FOLIO_ORIGIN", "https://notes.example/path")
	if _, err := Load(); err == nil {
		t.Fatal("含路径的 origin 未拒绝")
	}
	t.Setenv("FOLIO_ORIGIN", "https://notes.example")
	if cfg, err := Load(); err != nil {
		t.Fatal(err)
	} else if cfg.IndexLimit != 5<<20 {
		t.Fatal("默认正文索引上限应为 5 MiB")
	}
}
