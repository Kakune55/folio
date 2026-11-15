package main

import (
	"context"
	"folio/internal/auth"
	"folio/internal/s3test"
	"folio/internal/storage"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestStorageMigrateCommandBothDirections(t *testing.T) {
	base := t.TempDir()
	binary := filepath.Join(base, "folio")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "go", "build", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	server := httptest.NewServer(&s3test.Server{Objects: map[string]s3test.Object{}})
	defer server.Close()
	data := filepath.Join(base, "data")
	if err := os.Mkdir(data, 0700); err != nil {
		t.Fatal(err)
	}
	a, err := auth.Open(data, "命令迁移测试-1234567890")
	if err != nil {
		t.Fatal(err)
	}
	opts := storage.S3Options{Endpoint: server.URL, Bucket: "bucket", AccessKey: "test-key", SecretKey: "test-secret", PathStyle: true}
	remote, err := storage.NewS3(ctx, opts)
	if err != nil {
		t.Fatal(err)
	}
	if err = remote.Activate(a.Database()); err != nil {
		t.Fatal(err)
	}
	user, err := remote.OpenUser(1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = user.Write("原文.md", "\ufeff原文\r\n", "", true); err != nil {
		t.Fatal(err)
	}
	identity, err := user.Identity()
	if err != nil {
		t.Fatal(err)
	}
	remote.Close()
	workspace := filepath.Join(base, "local")
	prefix := ""
	run := func(ok bool, args ...string) {
		t.Helper()
		cmd := exec.CommandContext(ctx, binary, args...)
		for _, v := range os.Environ() {
			if !strings.HasPrefix(v, "FOLIO_") {
				cmd.Env = append(cmd.Env, v)
			}
		}
		cmd.Env = append(cmd.Env, "FOLIO_STORAGE_BACKEND=invalid", "FOLIO_ADDR=invalid", "FOLIO_WORKSPACE="+workspace, "FOLIO_APP_DATA="+data, "FOLIO_S3_ENDPOINT="+server.URL, "FOLIO_S3_BUCKET=bucket", "FOLIO_S3_ACCESS_KEY=test-key", "FOLIO_S3_SECRET_KEY=test-secret", "FOLIO_S3_PATH_STYLE=true", "FOLIO_S3_PREFIX="+prefix)
		out, e := cmd.CombinedOutput()
		if (e == nil) != ok {
			t.Fatalf("%v %s", e, out)
		}
		if strings.Contains(string(out), "test-secret") {
			t.Fatal("输出泄露凭据")
		}
		if ok && !strings.Contains(string(out), "校验") {
			t.Fatal("缺少进度", string(out))
		}
	}
	// 实例尚未停止，命令必须拒绝。
	run(false, "-storage-migrate", "s3", "local")
	a.Close()
	run(false, "-storage-migrate", "s3")
	run(false, "-storage-migrate", "local", "local")
	run(true, "-storage-migrate", "s3", "local")
	a, err = auth.Open(data, "")
	if err != nil {
		t.Fatal(err)
	}
	local, err := storage.NewLocal(workspace, data, a.Database())
	if err != nil {
		t.Fatal(err)
	}
	back, err := local.OpenUser(1)
	if err != nil {
		t.Fatal(err)
	}
	got, err := back.Identity()
	if err != nil || got != identity {
		t.Fatal("原生 S3 迁回身份变化", err)
	}
	content, err := back.Read("原文.md")
	if err != nil || content.Content != "\ufeff原文\r\n" {
		t.Fatal(content, err)
	}
	back.Close()
	local.Close()
	a.Close()
	// 使用新的空前缀完成另一方向；已有 S3 源保持不变。
	prefix = "returned"
	run(true, "-storage-migrate", "local", "s3")
}
