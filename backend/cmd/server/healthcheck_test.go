package main

import (
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestHealthcheckTLSAndHostname(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/healthz" {
			t.Error("探测路径错误")
		}
		w.WriteHeader(200)
	}))
	defer server.Close()
	parsed, _ := url.Parse(server.URL)
	certificate := filepath.Join(t.TempDir(), "cert.pem")
	if err := os.WriteFile(certificate, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.TLS.Certificates[0].Certificate[0]}), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FOLIO_ADDR", parsed.Host)
	t.Setenv("FOLIO_TLS_CERT", certificate)
	t.Setenv("FOLIO_ORIGIN", server.URL)
	missing := filepath.Join(t.TempDir(), "not-created")
	t.Setenv("FOLIO_WORKSPACE", missing)
	if err := healthcheck(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatal("健康探测修改了工作区")
	}
	t.Setenv("FOLIO_ORIGIN", "https://incorrect.example")
	if err := healthcheck(); err == nil {
		t.Fatal("健康探测跳过了 TLS 主机名校验")
	}
}
