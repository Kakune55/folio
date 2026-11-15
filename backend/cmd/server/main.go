package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"folio/internal/storage"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"folio/internal/auth"
	"folio/internal/config"
	"folio/internal/httpapi"
	"folio/internal/storagemigrate"
	"folio/web"
)

func main() {
	check := flag.Bool("healthcheck", false, "检查本进程服务是否存活")
	migrateS3 := flag.Bool("storage-migrate", false, "停服迁移存储：local s3 或 s3 local")
	migrate := flag.Bool("migrate-storage", false, "停服迁移回收载荷、分享快照并将分享库合入核心库")
	workspace := flag.String("workspace", "", "迁移使用的现有工作区根目录（必须显式指定）")
	reset := flag.Bool("reset-password", false, "停止服务后重置现有账号密码并撤销所有登录会话")
	appData := flag.String("app-data", "", "离线维护使用的现有应用数据目录（必须显式指定）")
	passwordFile := flag.String("password-file", "", "离线重置使用的私有新密码文件（不接受明文参数）")
	flag.Parse()
	maintenance := 0
	for _, v := range []bool{*reset, *check, *migrate, *migrateS3} {
		if v {
			maintenance++
		}
	}
	if (!*migrateS3 && flag.NArg() != 0) || (*migrateS3 && flag.NArg() != 2) || maintenance > 1 || (!*reset && *passwordFile != "") || (!*reset && !*migrate && !*migrateS3 && *appData != "") || (!*migrate && !*migrateS3 && *workspace != "") {
		log.Fatal("参数组合无效；使用 -help 查看帮助")
	}
	if *migrateS3 {
		if *workspace == "" {
			*workspace = os.Getenv("FOLIO_WORKSPACE")
			if *workspace == "" {
				*workspace = "./workspace"
			}
		}
		if *appData == "" {
			*appData = os.Getenv("FOLIO_APP_DATA")
			if *appData == "" {
				*appData = "./app-data"
			}
		}
		opts, err := config.S3FromEnv()
		if err != nil {
			log.Fatal(err)
		}
		err = storagemigrate.Between(*workspace, *appData, flag.Arg(0), flag.Arg(1), opts, func(p storage.TransferProgress) {
			fmt.Printf("\r用户 %d · %s %d/%d     ", p.UserID, p.Stage, p.Done, p.Total)
		})
		fmt.Println()
		if err != nil {
			log.Fatalf("存储迁移失败：%v；源数据保留，检查后可重试", err)
		}
		log.Printf("迁移完成，源数据保留。请设置 FOLIO_STORAGE_BACKEND=%s 后启动。", flag.Arg(1))
		return
	}

	if *migrate {
		if *workspace == "" || *appData == "" {
			log.Fatal("迁移必须显式指定 -workspace 和 -app-data；请先停服并保留两目录完整副本")
		}
		if err := storagemigrate.Run(*workspace, *appData); err != nil {
			log.Fatalf("存储迁移失败：%v；请保留原件、检查冲突后重试同一命令", err)
		}
		log.Print("存储布局迁移完成；旧回收载荷、分享快照与分享库仍保留在 app-data，核验前请勿删除。切换后勿直接运行旧版本。")
		return
	}

	if *reset {
		if *appData == "" || *passwordFile == "" {
			log.Fatal("重置必须显式指定 -app-data 和 -password-file；请先停止 Folio 并保存工作区及应用数据副本")
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
	accounts, err := auth.Open(cfg.AppData, cfg.InitialPassword)
	if err != nil {
		log.Fatal(err)
	}
	defer accounts.Close()
	handler, err := httpapi.NewAccounts(web.Assets(), cfg, accounts)
	if err != nil {
		log.Fatal(err)
	}
	defer handler.Close()
	server := &http.Server{Addr: cfg.Addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 120 * time.Second, WriteTimeout: 120 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	server.RegisterOnShutdown(handler.StopEvents)
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
	if cfg.DemoMode {
		log.Print("Demo 模式已开启：公开体验账号 folio，普通权限，配额 100 MiB；请使用独立数据目录，不要存放真实资料。")
	}
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
