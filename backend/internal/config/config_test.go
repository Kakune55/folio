package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTLSConfigurationRequiresPairAndHTTPSOrigin(t *testing.T) {
	t.Setenv("FOLIO_DEMO_MODE", "")
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

func TestDemoModeEnvironment(t *testing.T) {
	t.Setenv("FOLIO_WORKSPACE", filepath.Join(t.TempDir(), "workspace"))
	t.Setenv("FOLIO_APP_DATA", filepath.Join(t.TempDir(), "data"))
	t.Setenv("FOLIO_PASSWORD_FILE", "")
	t.Setenv("FOLIO_SECURE_COOKIE", "true")
	t.Setenv("FOLIO_ORIGIN", "")
	t.Setenv("FOLIO_TLS_CERT", "")
	t.Setenv("FOLIO_TLS_KEY", "")
	for _, tc := range []struct {
		value            string
		enabled, invalid bool
	}{{"", false, false}, {"false", false, false}, {"true", true, false}, {"invalid", false, true}} {
		t.Setenv("FOLIO_DEMO_MODE", tc.value)
		cfg, err := Load()
		if tc.invalid {
			if err == nil {
				t.Fatal("非法演示标志未拒绝")
			}
			continue
		}
		if err != nil || cfg.DemoMode != tc.enabled || !cfg.SecureCookie {
			t.Fatalf("Demo环境配置错误：%+v %v", cfg, err)
		}
	}
}

func TestS3ConfigurationDoesNotCreateLocalWorkspace(t *testing.T) {
	base := t.TempDir()
	workspace := filepath.Join(base, "unused-workspace")
	for key, value := range map[string]string{"FOLIO_STORAGE_BACKEND": "s3", "FOLIO_S3_ACCESS_KEY": "test-key", "FOLIO_S3_SECRET_KEY": "test-secret", "FOLIO_S3_BUCKET": "private-bucket", "FOLIO_S3_ENDPOINT": "https://objects.example", "FOLIO_S3_PATH_STYLE": "true", "FOLIO_WORKSPACE": workspace, "FOLIO_APP_DATA": filepath.Join(base, "data"), "FOLIO_ORIGIN": "", "FOLIO_SECURE_COOKIE": "true", "FOLIO_TLS_CERT": "", "FOLIO_TLS_KEY": "", "FOLIO_PASSWORD_FILE": "", "FOLIO_DEMO_MODE": "false"} {
		t.Setenv(key, value)
	}
	cfg, err := Load()
	if err != nil || cfg.StorageBackend != "s3" || !cfg.S3.PathStyle {
		t.Fatal(cfg, err)
	}
	if _, err = os.Stat(workspace); !os.IsNotExist(err) {
		t.Fatal("S3 模式创建了本地正文目录", err)
	}
	for _, endpoint := range []string{"file:///secret", "https://user:password@objects.example", "https://objects.example?secret=1"} {
		t.Setenv("FOLIO_S3_ENDPOINT", endpoint)
		if _, err = Load(); err == nil {
			t.Fatal("接受不安全端点", endpoint)
		}
	}
	t.Setenv("FOLIO_S3_ENDPOINT", "")
	t.Setenv("FOLIO_S3_BUCKET", "")
	if _, err = Load(); err == nil {
		t.Fatal("缺失桶名仍通过配置")
	}
}

func TestS3StaticCredentialsRequiredWithoutAWSFallback(t *testing.T) {
	t.Setenv("FOLIO_S3_BUCKET", "private-bucket")
	t.Setenv("FOLIO_S3_ENDPOINT", "")
	t.Setenv("FOLIO_S3_PATH_STYLE", "")
	t.Setenv("FOLIO_S3_REGION", "region-test")
	t.Setenv("AWS_ACCESS_KEY_ID", "must-not-use")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "must-not-use")
	t.Setenv("AWS_SESSION_TOKEN", "must-not-use")
	for _, pair := range [][2]string{{"", ""}, {"key", ""}, {"", "secret"}} {
		t.Setenv("FOLIO_S3_ACCESS_KEY", pair[0])
		t.Setenv("FOLIO_S3_SECRET_KEY", pair[1])
		if _, err := S3FromEnv(); err == nil {
			t.Fatal("缺少静态密钥仍通过配置")
		}
	}
	t.Setenv("FOLIO_S3_ACCESS_KEY", "folio-key")
	t.Setenv("FOLIO_S3_SECRET_KEY", "folio-secret")
	opts, err := S3FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if opts.AccessKey != "folio-key" || opts.SecretKey != "folio-secret" || opts.Region != "region-test" {
		t.Fatal("没有使用 Folio 显式凭据及地域")
	}
}
