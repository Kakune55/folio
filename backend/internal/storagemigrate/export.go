package storagemigrate

import (
	"context"
	"errors"
	"folio/internal/auth"
	"folio/internal/fileio"
	"folio/internal/storage"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func fromS3(workspace, appData string, opts storage.S3Options, report storage.ProgressFunc) error {
	w, err := resolveDirectory(workspace)
	if err != nil {
		return err
	}
	d, err := filepath.EvalSymlinks(appData)
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
	if filepath.Dir(w) == w {
		return errors.New("工作区不能为文件系统根目录")
	}
	a, err := auth.OpenExisting(d)
	if err != nil {
		return err
	}
	defer a.Close()
	b, err := storage.NewS3(context.Background(), opts)
	if err != nil {
		return err
	}
	defer b.Close()
	var binding string
	if err = a.Database().QueryRow("SELECT identity FROM workspace_backend WHERE id=1").Scan(&binding); err != nil {
		return err
	}
	if binding != b.Binding() {
		return errors.New("源 S3 配置与应用数据绑定不一致")
	}
	if err = prepareLocalTarget(w, binding); err != nil {
		return err
	}
	users, _, err := a.Users("", 0, int(^uint(0)>>1))
	if err != nil {
		return err
	}
	allowed := map[string]bool{".folio-migration": true}
	for _, u := range users {
		allowed[strconv.FormatInt(u.ID, 10)] = true
	}
	entries, err := os.ReadDir(w)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !allowed[entry.Name()] {
			return errors.New("本地迁移目标包含其他条目，拒绝切换")
		}
	}
	for _, u := range users {
		if err = b.ExportLocalUser(w, u.ID, report); err != nil {
			return err
		}
	}
	tx, err := a.Database().Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.Exec("UPDATE workspace_backend SET identity='local' WHERE id=1 AND identity=?", binding)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return errors.New("源绑定已变化")
	}
	if _, err = tx.Exec("CREATE TABLE IF NOT EXISTS storage_layout(version INTEGER PRIMARY KEY CHECK(version=1),complete INTEGER NOT NULL CHECK(complete IN (0,1)))"); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO storage_layout(version,complete) VALUES(1,1) ON CONFLICT(version) DO UPDATE SET complete=1"); err != nil {
		return err
	}
	return tx.Commit()
}
func resolveDirectory(name string) (string, error) {
	absolute, err := filepath.Abs(name)
	if err != nil {
		return "", err
	}
	existing := absolute
	var suffix []string
	for {
		resolved, e := filepath.EvalSymlinks(existing)
		if e == nil {
			for i := len(suffix) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, suffix[i])
			}
			return resolved, nil
		}
		if !errors.Is(e, os.ErrNotExist) {
			return "", e
		}
		parent := filepath.Dir(existing)
		if parent == existing {
			return "", e
		}
		suffix = append(suffix, filepath.Base(existing))
		existing = parent
	}
}
func prepareLocalTarget(directory, source string) error {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return err
	}
	defer root.Close()
	const marker = ".folio-migration"
	expected := "folio-storage-migration-v1\n" + source + "\n"
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	if len(entries) != 0 {
		f, e := fileio.Open(root, marker, os.O_RDONLY, 0)
		if e != nil {
			return errors.New("本地迁移目标非空，请选择空的 FOLIO_WORKSPACE")
		}
		defer f.Close()
		if e = fileio.CheckSingleLink(f); e != nil {
			return e
		}
		data, e := io.ReadAll(io.LimitReader(f, int64(len(expected)+1)))
		if e != nil {
			return e
		}
		if string(data) != expected {
			return errors.New("本地目标属于其他迁移")
		}
		return nil
	}
	f, err := root.OpenFile(marker, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = f.WriteString(expected)
	if err == nil {
		err = f.Sync()
	}
	return errors.Join(err, f.Close())
}
