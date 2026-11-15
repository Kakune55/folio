// Package storagemigrate 只负责旧本地布局的停服迁移；保留原件，不提供备份功能。
package storagemigrate

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"folio/internal/auth"
	"folio/internal/fileio"
	"folio/internal/layout"
	"folio/internal/sharing"
	"folio/internal/storage"
	"folio/internal/trash"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Run 获取现有账号库实例锁，全部载荷校验完成后一次事务切换分享表与布局版本。
func Run(workspace, appData string) error {
	w, err := filepath.Abs(workspace)
	if err != nil {
		return err
	}
	d, err := filepath.Abs(appData)
	if err != nil {
		return err
	}
	w, err = filepath.EvalSymlinks(w)
	if err != nil {
		return err
	}
	d, err = filepath.EvalSymlinks(d)
	if err != nil {
		return err
	}
	for _, pair := range [][2]string{{w, d}, {d, w}} {
		rel, e := filepath.Rel(pair[0], pair[1])
		if e == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return errors.New("工作区与应用数据目录不能互相包含")
		}
	}
	accounts, err := auth.OpenExisting(d)
	if err != nil {
		return err
	}
	defer accounts.Close()
	db := accounts.Database()
	complete, err := layout.Complete(db)
	if err != nil {
		return err
	}
	if complete {
		return errors.New("存储布局已完成切换，拒绝再次导入保留的旧数据")
	}
	roots, err := os.OpenRoot(w)
	if err != nil {
		return err
	}
	defer roots.Close()
	data, err := os.OpenRoot(d)
	if err != nil {
		return err
	}
	defer data.Close()
	if err = layout.CheckNames(roots); err != nil {
		return err
	}
	var old *sql.DB
	if _, e := data.Lstat("shares"); e == nil {
		for _, name := range []string{"shares/shares.db", "shares/shares.db-wal", "shares/shares.db-shm", "shares/shares.db-journal"} {
			f, e := fileio.Open(data, name, os.O_RDONLY, 0)
			if errors.Is(e, os.ErrNotExist) && name != "shares/shares.db" {
				continue
			}
			if e != nil {
				return e
			}
			e = fileio.CheckSingleLink(f)
			f.Close()
			if e != nil {
				return e
			}
		}
		old, err = sql.Open("sqlite", fileio.FileURL(filepath.Join(d, "shares", "shares.db"))+"?mode=ro&_pragma=trusted_schema(OFF)&_pragma=busy_timeout(5000)")
		if err != nil {
			return err
		}
		defer old.Close()
		old.SetMaxOpenConns(1)
		var check string
		if err = old.QueryRow("PRAGMA integrity_check").Scan(&check); err != nil {
			return err
		}
		if check != "ok" {
			return errors.New("旧分享库完整性检查失败")
		}
		var triggers int
		if err = old.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='trigger'").Scan(&triggers); err != nil {
			return err
		}
		if triggers != 0 {
			return errors.New("旧分享库包含未知触发器")
		}
	} else if !errors.Is(e, os.ErrNotExist) {
		return e
	}
	// 迁移所有账号，包括没有活跃会话的账号；不改变用户根本身，保留工作区身份。
	users, _, err := accounts.Users("", 0, int(^uint(0)>>1))
	if err != nil {
		return err
	}
	known := map[int64]bool{}
	for _, u := range users {
		known[u.ID] = true
		if err = layout.EnsureOwner(roots, u.ID); err != nil {
			return err
		}
		src := strconv.FormatInt(u.ID, 10) + "/trash"
		if _, e := data.Lstat(src); e == nil {
			if err = checkTrashPaths(data, src); err != nil {
				return err
			}
			if err = copyVerified(data, src, roots, layout.OwnerDir(u.ID)+"/trash"); err != nil {
				return fmt.Errorf("迁移回收站 %d：%w", u.ID, err)
			}
		} else if !errors.Is(e, os.ErrNotExist) {
			return e
		}
		src = "shares/" + strconv.FormatInt(u.ID, 10)
		if _, e := data.Lstat(src); e == nil {
			if err = copyVerified(data, src, roots, layout.OwnerDir(u.ID)+"/shares"); err != nil {
				return fmt.Errorf("迁移分享载荷 %d：%w", u.ID, err)
			}
		} else if !errors.Is(e, os.ErrNotExist) {
			return e
		}
	}
	// 未知用户目录不能被静默遗漏。
	if err = checkOwners(data, ".", known); err != nil {
		return err
	}
	if old != nil {
		if err = checkOwners(data, "shares", known); err != nil {
			return err
		}
	}
	if err = sharing.InitSchema(db); err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var n int
	if err = tx.QueryRow("SELECT (SELECT count(*) FROM shares)+(SELECT count(*) FROM grants)").Scan(&n); err != nil {
		return err
	}
	if n != 0 {
		return errors.New("核心库已有分享数据，拒绝合并覆盖")
	}
	if old != nil {
		if err = importShares(old, tx, roots, known); err != nil {
			return err
		}
		rows, e := old.Query("SELECT token,share_id,version,expires FROM grants")
		if e != nil {
			return e
		}
		for rows.Next() {
			var token, id, version string
			var expires int64
			if e = rows.Scan(&token, &id, &version, &expires); e != nil {
				rows.Close()
				return e
			}
			if _, e = tx.Exec("INSERT INTO grants(token,share_id,version,expires) VALUES(?,?,?,?)", token, id, version, expires); e != nil {
				rows.Close()
				return e
			}
		}
		err = errors.Join(rows.Err(), rows.Close())
		if err != nil {
			return err
		}
	}
	var orphan int
	if err = tx.QueryRow("SELECT count(*) FROM grants g LEFT JOIN shares s ON s.id=g.share_id WHERE s.id IS NULL").Scan(&orphan); err != nil {
		return err
	}
	if orphan != 0 {
		return errors.New("旧访客资格引用不存在的分享，拒绝切换")
	}
	if _, err = tx.Exec("INSERT INTO storage_layout(version,complete) VALUES(1,1)"); err != nil {
		return err
	}
	return tx.Commit()
}

func checkOwners(root *os.Root, name string, known map[int64]bool) error {
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
		id, err := strconv.ParseInt(e.Name(), 10, 64)
		if err == nil && (!known[id] || strconv.FormatInt(id, 10) != e.Name()) {
			return fmt.Errorf("旧目录 %s 含未知用户 %s，请先检查归属", name, e.Name())
		}
	}
	return nil
}
func importShares(old *sql.DB, tx *sql.Tx, roots *os.Root, known map[int64]bool) error {
	rows, err := old.Query("SELECT id,owner,record,payload,salt,hash FROM shares")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, raw, payload string
		var owner int64
		var salt, hash []byte
		if err = rows.Scan(&id, &owner, &raw, &payload, &salt, &hash); err != nil {
			return err
		}
		if !known[owner] {
			return errors.New("分享记录含未知用户")
		}
		var r sharing.Record
		if err = json.Unmarshal([]byte(raw), &r); err != nil {
			return err
		}
		if r.ID != id || storage.ValidPath(r.Root, false) != nil {
			return errors.New("分享记录 ID 或原路径无效")
		}
		if payload != "" {
			prefix := strconv.FormatInt(owner, 10) + "/"
			if storage.ValidPath(strings.TrimPrefix(payload, prefix), false) != nil || !strings.HasPrefix(payload, prefix) || strings.ContainsAny(strings.TrimPrefix(payload, prefix), "/\\") || strings.TrimPrefix(payload, prefix) == "" {
				return errors.New("旧分享载荷路径无效")
			}
			payload = layout.OwnerDir(owner) + "/shares/" + strings.TrimPrefix(payload, prefix)
			for _, f := range r.Files {
				if storage.ValidPath(f.Path, false) != nil {
					return errors.New("分享文件路径无效")
				}
				actual, e := digest(roots, path.Join(payload, f.Path))
				if e != nil {
					return e
				}
				if "sha256:"+actual != f.Revision {
					return errors.New("分享快照摘要不匹配，保留原件并拒绝切换")
				}
			}
		}
		if _, err = tx.Exec("INSERT INTO shares(id,owner,record,payload,salt,hash) VALUES(?,?,?,?,?,?)", id, owner, raw, payload, salt, hash); err != nil {
			return err
		}
	}
	return rows.Err()
}
func digest(root *os.Root, name string) (string, error) {
	f, err := fileio.Open(root, name, os.O_RDONLY, 0)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if err = fileio.CheckSingleLink(f); err != nil {
		return "", err
	}
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// copyTree 可重复执行；目标已有文件只核对，绝不覆盖。每个文件先临时写入再不覆盖发布。
func copyTree(src *os.Root, from string, dst *os.Root, to string) error {
	f, err := fileio.Open(src, from, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.IsDir() {
		if err = dst.Mkdir(to, info.Mode().Perm()); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		checked, e := fileio.Open(dst, to, os.O_RDONLY, 0)
		if e != nil {
			return e
		}
		outInfo, e := checked.Stat()
		if e != nil {
			checked.Close()
			return e
		}
		if !outInfo.IsDir() {
			checked.Close()
			return fileio.ErrUnsafe
		}
		out, e := checked.ReadDir(-1)
		checked.Close()
		if e != nil {
			return e
		}
		entries, e := f.ReadDir(-1)
		if e != nil {
			return e
		}
		names := map[string]bool{}
		for _, entry := range entries {
			names[entry.Name()] = true
		}
		for _, entry := range out {
			if !names[entry.Name()] && !migrationTemp(entries, to, entry.Name()) {
				return fmt.Errorf("目标 %s 含额外文件 %s，拒绝覆盖", to, entry.Name())
			}
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".folio-tmp-migrate-") {
				return errors.New("源目录含迁移保留名称")
			}
			if err = copyTree(src, path.Join(from, entry.Name()), dst, path.Join(to, entry.Name())); err != nil {
				return err
			}
		}
		r, e := dst.OpenRoot(to)
		if e != nil {
			return e
		}
		defer r.Close()
		return fileio.SyncRoot(r)
	}
	if err = fileio.CheckSingleLink(f); err != nil {
		return err
	}
	expected, err := digest(src, from)
	if err != nil {
		return err
	}
	if _, e := dst.Lstat(to); e == nil {
		actual, e := digest(dst, to)
		if e != nil {
			return e
		}
		if expected != actual {
			return fmt.Errorf("目标 %s 与原件不同，拒绝覆盖", to)
		}
		return nil
	} else if !errors.Is(e, os.ErrNotExist) {
		return e
	}
	parent, err := dst.OpenRoot(path.Dir(to))
	if err != nil {
		return err
	}
	defer parent.Close()
	sum := sha256.Sum256([]byte(to))
	temp := ".folio-tmp-migrate-" + hex.EncodeToString(sum[:])
	// 临时名称由目标路径确定，仅在离线迁移中清理上次未发布的片段。
	if err = parent.Remove(temp); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	output, err := parent.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
	if err != nil {
		return err
	}
	defer parent.Remove(temp)
	_, err = io.Copy(output, f)
	if err == nil {
		err = output.Sync()
	}
	err = errors.Join(err, output.Close())
	if err != nil {
		return err
	}
	actual, err := digest(parent, temp)
	if err != nil {
		return err
	}
	after, err := digest(src, from)
	if err != nil {
		return err
	}
	if actual != expected || after != expected {
		return errors.New("复制期间原件发生变化，拒绝发布")
	}
	if err = fileio.Rename(parent, temp, parent, path.Base(to)); err != nil {
		return err
	}
	return fileio.SyncRoot(parent)
}

func migrationTemp(entries []os.DirEntry, to, name string) bool {
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		sum := sha256.Sum256([]byte(path.Join(to, e.Name())))
		if name == ".folio-tmp-migrate-"+hex.EncodeToString(sum[:]) {
			return true
		}
	}
	return false
}

// 切换前再次核对整个源树与目标树，包含空目录与文件名，拒绝遗漏及并发外写。
func copyVerified(src *os.Root, from string, dst *os.Root, to string) error {
	before, err := treeDigest(src, from)
	if err != nil {
		return err
	}
	if err = copyTree(src, from, dst, to); err != nil {
		return err
	}
	after, err := treeDigest(src, from)
	if err != nil {
		return err
	}
	actual, err := treeDigest(dst, to)
	if err != nil {
		return err
	}
	if before != after || before != actual {
		return errors.New("迁移前后目录或内容不一致，请停止外部写入并检查目标；原件仍保留")
	}
	return nil
}
func treeDigest(root *os.Root, name string) (string, error) {
	f, err := fileio.Open(root, name, os.O_RDONLY, 0)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		sum, err := digest(root, name)
		return "file:" + sum, err
	}
	entries, err := f.ReadDir(-1)
	if err != nil {
		return "", err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	h := sha256.New()
	h.Write([]byte("directory\x00"))
	for _, e := range entries {
		sum, err := treeDigest(root, path.Join(name, e.Name()))
		if err != nil {
			return "", err
		}
		fmt.Fprintf(h, "%d:%s:%s\x00", len(e.Name()), e.Name(), sum)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// 旧回收记录若使用新保留名称，要求先在旧版本恢复并改名，避免迁移后无法恢复。
func checkTrashPaths(root *os.Root, name string) error {
	dir, err := fileio.Open(root, name, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	entries, err := dir.ReadDir(-1)
	dir.Close()
	if err != nil {
		return err
	}
	for _, e := range entries {
		if !trash.ValidID(e.Name()) {
			return fmt.Errorf("旧回收站 %s 含未知条目 %s，请先检查", name, e.Name())
		}
		f, err := fileio.Open(root, path.Join(name, e.Name(), "record.json"), os.O_RDONLY, 0)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		var record trash.Record
		err = json.NewDecoder(io.LimitReader(f, 65537)).Decode(&record)
		f.Close()
		// 损坏清单仍完整保留供人工恢复，不猜测原路径。
		if err != nil {
			continue
		}
		for _, part := range strings.Split(record.Path, "/") {
			if strings.EqualFold(part, ".folio") {
				return fmt.Errorf("旧回收记录 %s 原路径包含 .folio，请先用旧版本恢复并移走冲突内容", e.Name())
			}
		}
	}
	return nil
}
