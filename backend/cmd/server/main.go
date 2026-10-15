package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"folio/internal/auth"
	"folio/internal/config"
	"folio/internal/httpapi"
	"folio/internal/storage"
	"folio/web"
)

func main() {
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
	server := &http.Server{Addr: cfg.Addr, Handler: httpapi.New(web.Assets(), httpapi.Options{Auth: accounts, Workspace: store, SecureCookie: cfg.SecureCookie, Origin: cfg.Origin}), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 120 * time.Second, WriteTimeout: 120 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20}
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
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	<-shutdownDone
}
