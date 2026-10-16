package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"folio/internal/auth"
	"folio/internal/config"
	"folio/internal/httpapi"
	"folio/internal/search"
	"folio/internal/storage"
	"folio/internal/trash"
	"folio/web"
	"path/filepath"
)

func main() {
	check := flag.Bool("healthcheck", false, "检查本进程服务是否存活")
	reset := flag.Bool("reset-password", false, "停止服务后重置现有账号密码并撤销所有登录会话")
	appData := flag.String("app-data", "", "离线重置使用的现有应用数据目录（必须显式指定）")
	passwordFile := flag.String("password-file", "", "离线重置使用的私有新密码文件（不接受明文参数）")
	flag.Parse()
	if flag.NArg() != 0 || (*reset && *check) || (!*reset && (*appData != "" || *passwordFile != "")) {
		log.Fatal("参数组合无效；使用 -help 查看帮助")
	}
	if *reset {
		if *appData == "" || *passwordFile == "" {
			log.Fatal("重置必须显式指定 -app-data 和 -password-file；请先停止 Folio 并备份两卷")
		}
		if err := auth.ResetPassword(*appData, *passwordFile); err != nil {
			log.Fatal(err)
		}
		log.Print("密码已重置，所有旧登录会话已撤销。请删除或妥善保管本次密码文件；旧引导密码文件不会更新。")
		return
	}
	if *check {
		if err := healthcheck(); err != nil {
			log.Print(err)
			os.Exit(1)
		}
		return
	}
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	store, err := storage.Open(cfg.Workspace)
	if err != nil {
		log.Fatal(err)
	}
	defer store.Close()
	if err = store.SetLimits(cfg.Limits); err != nil {
		log.Fatal(err)
	}
	accounts, err := auth.Open(cfg.AppData, cfg.InitialPassword)
	if err != nil {
		log.Fatal(err)
	}
	defer accounts.Close()
	recovery, err := trash.Open(filepath.Join(cfg.AppData, "trash"))
	if err != nil {
		log.Fatal(err)
	}
	defer recovery.Close()
	store.SetTrash(recovery)
	index, err := search.Open(cfg.AppData, store, cfg.IndexLimit)
	if err != nil {
		log.Fatal(err)
	}
	defer index.Close()
	identity, err := store.Identity()
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{Addr: cfg.Addr, Handler: httpapi.New(web.Assets(), httpapi.Options{Auth: accounts, Search: index, Workspace: store, WorkspaceID: accounts.WorkspaceID(identity), SecureCookie: cfg.SecureCookie, Origin: cfg.Origin}), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 120 * time.Second, WriteTimeout: 120 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("服务关闭失败：%v", err)
		}
	}()
	log.Printf("Folio 已启动：%s；首次生成的密码位于应用数据目录 initial-password 文件，账号 admin", cfg.Addr)
	if cfg.TLSCert != "" {
		err = server.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey)
	} else {
		err = server.ListenAndServe()
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	<-shutdownDone
}
