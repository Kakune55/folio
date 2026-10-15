package config

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	Addr, Workspace, AppData, InitialPassword, Origin string
	SecureCookie                                      bool
}

func Load() (Config, error) {
	get := func(key, fallback string) string {
		if value := os.Getenv(key); value != "" {
			return value
		}
		return fallback
	}
	c := Config{Addr: get("FOLIO_ADDR", "127.0.0.1:8080"), Workspace: get("FOLIO_WORKSPACE", "./workspace"), AppData: get("FOLIO_APP_DATA", "./app-data"), Origin: os.Getenv("FOLIO_ORIGIN"), SecureCookie: true}
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
	for _, dir := range []string{c.Workspace, c.AppData} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return c, err
		}
	}
	var err error
	c.Workspace, err = filepath.EvalSymlinks(c.Workspace)
	if err != nil {
		return c, err
	}
	c.Workspace, err = filepath.Abs(c.Workspace)
	if err != nil {
		return c, err
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
	if contains(c.Workspace, c.AppData) || contains(c.AppData, c.Workspace) {
		return c, errors.New("工作区和应用数据目录必须分离，不能相互包含")
	}
	if err = os.Chmod(c.AppData, 0o700); err != nil {
		return c, err
	}
	if file := os.Getenv("FOLIO_PASSWORD_FILE"); file != "" {
		bytes, err := os.ReadFile(file)
		if err != nil {
			return c, err
		}
		c.InitialPassword = strings.TrimSuffix(strings.TrimSuffix(string(bytes), "\n"), "\r")
	}
	return c, nil
}
