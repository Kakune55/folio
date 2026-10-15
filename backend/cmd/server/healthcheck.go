package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"time"
)

// 健康探测只读配置和公开证书，不初始化数据目录或获取实例锁。
func healthcheck() error {
	address := os.Getenv("FOLIO_ADDR")
	if address == "" {
		address = "127.0.0.1:8080"
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	scheme := "http"
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if certificate := os.Getenv("FOLIO_TLS_CERT"); certificate != "" {
		scheme = "https"
		pem, err := os.ReadFile(certificate)
		if err != nil {
			return err
		}
		roots := x509.NewCertPool()
		if !roots.AppendCertsFromPEM(pem) {
			return errors.New("健康探测证书无效")
		}
		serverName := host
		if external, err := url.Parse(os.Getenv("FOLIO_ORIGIN")); err == nil && external.Hostname() != "" {
			serverName = external.Hostname()
		}
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots, ServerName: serverName}
	}
	client := http.Client{Timeout: 3 * time.Second, Transport: transport}
	response, err := client.Get(scheme + "://" + net.JoinHostPort(host, port) + "/api/v1/healthz")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1024))
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("健康探测返回 %d", response.StatusCode)
	}
	return nil
}
