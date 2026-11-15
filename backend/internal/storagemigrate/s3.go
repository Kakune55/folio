package storagemigrate

import (
	"context"
	"errors"
	"folio/internal/auth"
	"folio/internal/layout"
	"folio/internal/storage"
	"os"
	"path/filepath"
	"strings"
)

func ToS3(workspace, appData string, opts storage.S3Options) error {
	return Between(workspace, appData, "local", "s3", opts, nil)
}
func Between(workspace, appData, from, to string, opts storage.S3Options, report storage.ProgressFunc) error {
	if !((from == "local" && to == "s3") || (from == "s3" && to == "local")) {
		return errors.New("源和目标必须为不同的 local、s3")
	}
	if from == "s3" {
		return fromS3(workspace, appData, opts, report)
	}
	w, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		return err
	}
	d, err := filepath.EvalSymlinks(appData)
	if err != nil {
		return err
	}
	w, err = filepath.Abs(w)
	if err != nil {
		return err
	}
	d, err = filepath.Abs(d)
	if err != nil {
		return err
	}
	for _, p := range [][2]string{{w, d}, {d, w}} {
		rel, e := filepath.Rel(p[0], p[1])
		if e == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return errors.New("工作区与应用数据目录不能相互包含")
		}
	}
	a, err := auth.OpenExisting(d)
	if err != nil {
		return err
	}
	defer a.Close()
	db := a.Database()
	complete, err := layout.Complete(db)
	if err != nil {
		return err
	}
	if !complete {
		return errors.New("请先以 local 模式启动一次，或先完成 -migrate-storage 布局迁移")
	}
	if err = storage.BindBackend(db, "local"); err != nil {
		return err
	}
	root, err := os.OpenRoot(w)
	if err != nil {
		return err
	}
	err = layout.CheckNames(root)
	root.Close()
	if err != nil {
		return err
	}
	b, err := storage.NewS3(context.Background(), opts)
	if err != nil {
		return err
	}
	users, _, err := a.Users("", 0, int(^uint(0)>>1))
	if err != nil {
		return err
	}
	for _, u := range users {
		if err = b.ImportLocalUserProgress(w, u.ID, report); err != nil {
			return err
		}
	}
	// 全部用户原字节校验成功后，唯一一次事务切换后端身份，不删除本地原件。
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("UPDATE workspace_backend SET identity=? WHERE id=1 AND identity='local'", b.Binding()); err != nil {
		return err
	}
	return tx.Commit()
}
