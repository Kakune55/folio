// Package layout 管理本地工作区私有目录及布局版本，不提供普通文件访问入口。
package layout

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"folio/internal/fileio"
	"io"
	"os"
	"path"
	"strconv"
	"strings"
)

const marker = "Folio 私有存储布局 v1\n"

func ownerName(id int64) string { return strconv.FormatInt(id, 10) }
func OwnerDir(id int64) string  { return ownerName(id) + "/.folio" }

// EnsureOwner 以不覆盖发布创建私有目录；已有同名用户内容绝不接管。
func EnsureOwner(root *os.Root, id int64) error {
	if id <= 0 {
		return errors.New("用户 ID 无效")
	}
	name := ownerName(id)
	if err := root.Mkdir(name, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	f, err := fileio.Open(root, name, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	info, err := f.Stat()
	f.Close()
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fileio.ErrUnsafe
	}
	user, err := root.OpenRoot(name)
	if err != nil {
		return err
	}
	defer user.Close()
	if _, err = user.Lstat(".folio"); err == nil {
		return validate(user)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	var b [12]byte
	if _, err = rand.Read(b[:]); err != nil {
		return err
	}
	temp := ".folio-tmp-system-" + hex.EncodeToString(b[:])
	if err = user.Mkdir(temp, 0700); err != nil {
		return err
	}
	defer user.RemoveAll(temp)
	stage, err := user.OpenRoot(temp)
	if err != nil {
		return err
	}
	defer stage.Close()
	for _, dir := range []string{"trash", "shares"} {
		if err = stage.Mkdir(dir, 0700); err != nil {
			return err
		}
	}
	file, err := stage.OpenFile("layout", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = file.WriteString(marker)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = fileio.SyncRoot(stage); err != nil {
		return err
	}
	if err = fileio.Rename(user, temp, user, ".folio"); err != nil {
		return err
	}
	return fileio.SyncRoot(user)
}
func validate(user *os.Root) error {
	f, err := fileio.Open(user, ".folio/layout", os.O_RDONLY, 0)
	if err != nil {
		return fmt.Errorf(".folio 已存在但不是受管系统目录，请保留并移走冲突内容：%w", err)
	}
	defer f.Close()
	if err = fileio.CheckSingleLink(f); err != nil {
		return err
	}
	b, err := io.ReadAll(io.LimitReader(f, 128))
	if err != nil {
		return err
	}
	if string(b) != marker {
		return errors.New(".folio 与系统保留目录冲突，请保留并移走原目录")
	}
	for _, name := range []string{"trash", "shares"} {
		f, err := fileio.Open(user, ".folio/"+name, os.O_RDONLY, 0)
		if err != nil {
			return err
		}
		info, err := f.Stat()
		f.Close()
		if err != nil {
			return err
		}
		if !info.IsDir() {
			return fileio.ErrUnsafe
		}
	}
	return nil
}
func InitDB(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS storage_layout(version INTEGER PRIMARY KEY CHECK(version=1), complete INTEGER NOT NULL CHECK(complete IN (0,1)));`)
	return err
}
func Complete(db *sql.DB) (bool, error) {
	if err := InitDB(db); err != nil {
		return false, err
	}
	var n int
	err := db.QueryRow("SELECT complete FROM storage_layout WHERE version=1").Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return n == 1, err
}
func MarkComplete(db *sql.DB) error {
	_, err := db.Exec("INSERT INTO storage_layout(version,complete) VALUES(1,1) ON CONFLICT(version) DO UPDATE SET complete=1")
	return err
}

// CheckNames 在切换保留命名空间前检查旧用户文件，普通隐藏目录不受影响。
func CheckNames(root *os.Root) error {
	var walk func(string, bool) error
	walk = func(name string, userRoot bool) error {
		f, err := fileio.Open(root, name, os.O_RDONLY, 0)
		if err != nil {
			return err
		}
		entries, err := f.ReadDir(-1)
		f.Close()
		if err != nil {
			return err
		}
		for _, e := range entries {
			child := path.Join(name, e.Name())
			if strings.EqualFold(e.Name(), ".folio") {
				if !userRoot || e.Name() != ".folio" {
					return fmt.Errorf("用户路径 %s 与系统保留名称冲突，请先移走", child)
				}
				u, err := root.OpenRoot(name)
				if err != nil {
					return err
				}
				err = validate(u)
				u.Close()
				if err != nil {
					return fmt.Errorf("%s：%w", child, err)
				}
				continue
			}
			if e.IsDir() {
				if err = walk(child, false); err != nil {
					return err
				}
			}
		}
		return nil
	}
	f, err := root.Open(".")
	if err != nil {
		return err
	}
	entries, err := f.ReadDir(-1)
	f.Close()
	if err != nil {
		return err
	}
	for _, e := range entries {
		id, err := strconv.ParseInt(e.Name(), 10, 64)
		if err != nil || id <= 0 || ownerName(id) != e.Name() {
			continue
		}
		if err = walk(e.Name(), true); err != nil {
			return err
		}
	}
	return nil
}
func HasLegacy(data *os.Root) (bool, error) {
	if _, err := data.Lstat("shares"); err == nil {
		return true, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	f, err := data.Open(".")
	if err != nil {
		return false, err
	}
	entries, err := f.ReadDir(-1)
	f.Close()
	if err != nil {
		return false, err
	}
	for _, e := range entries {
		id, err := strconv.ParseInt(e.Name(), 10, 64)
		if err != nil || id <= 0 {
			continue
		}
		if _, err = data.Lstat(e.Name() + "/trash"); err == nil {
			return true, nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return false, err
		}
	}
	return false, nil
}
