package storage

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"folio/internal/fileio"
	"folio/internal/trash"
	"io"
	"os"
	"path"
	"strings"
)

// ExportLocalUser 仅供停服迁移使用；目标由调用方确认为空或为同一次迁移的未完成副本。
func (b *S3Backend) ExportLocalUser(directory string, id int64, report ProgressFunc) error {
	reportTransfer(report, id, "扫描", 0, 0)
	workspace, err := b.OpenUser(id)
	if err != nil {
		return err
	}
	r := workspace.(*S3Store)
	r.mu.Lock()
	defer r.mu.Unlock()
	if err = r.ready(); err != nil {
		return err
	}
	before, err := r.objects()
	if err != nil {
		return err
	}
	target, err := OpenManaged(directory, id)
	if err != nil {
		return err
	}
	defer target.Close()
	expected := map[string]string{".folio/": digest(nil), ".folio/trash/": digest(nil), ".folio/shares/": digest(nil), ".folio/identity": digest([]byte(r.identity))}
	marker, err := readTransferFile(target.root, ".folio/layout")
	if err != nil {
		return err
	}
	expected[".folio/layout"] = digest(marker)
	if err = writeTransferFile(target.root, ".folio/identity", []byte(r.identity)); err != nil {
		return err
	}
	total, done := 0, 0
	for _, o := range before {
		if o.Name != ".folio/layout" && o.Name != ".folio/identity" {
			total++
		}
	}
	for _, o := range before {
		if o.Name == ".folio/layout" || o.Name == ".folio/identity" {
			continue
		}
		name := strings.TrimSuffix(o.Name, "/")
		if err = validTransferPath(name); err != nil {
			return err
		}
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			expected[parent+"/"] = digest(nil)
		}
		data, info, e := r.get(o.Name, 1<<30)
		if e != nil {
			return e
		}
		if info.ETag != o.ETag || info.Size != o.Size {
			return fail("file_changed")
		}
		if strings.HasSuffix(o.Name, "/") {
			if len(data) != 0 {
				return fail("unsupported_file_type")
			}
			if err = transferDir(target.root, name); err != nil {
				return err
			}
			expected[o.Name] = digest(nil)
		} else {
			if strings.HasPrefix(name, ".folio/trash/") && strings.HasSuffix(name, "/record.json") {
				rec, e := transferTrashRecord(data, name)
				if e != nil {
					return e
				}
				// 目录版本含本地权限位，重新计算恢复校验；正文、附件与快照字节不变。
				if rec.Kind == "directory" {
					rev, _, e := revisionOf(rootOpener(target.root), path.Dir(name)+"/payload")
					if e != nil {
						return e
					}
					rec.Revision = rev
					data, e = json.Marshal(rec)
					if e != nil {
						return e
					}
				}
			}
			if err = writeTransferFile(target.root, name, data); err != nil {
				return err
			}
			expected[name] = digest(data)
		}
		done++
		reportTransfer(report, id, "复制", done, total)
	}
	actual, err := localInventory(target.root)
	if err != nil {
		return err
	}
	if len(actual) != len(expected) {
		return errors.New("本地目标包含额外或缺失条目，拒绝切换")
	}
	keys := sortedKeys(expected)
	for i, name := range keys {
		if actual[name] != expected[name] {
			return errors.New("本地目标校验失败，原件保留")
		}
		reportTransfer(report, id, "校验", i+1, len(keys))
	}
	after, err := r.objects()
	if err != nil {
		return err
	}
	if len(before) != len(after) {
		return fail("file_changed")
	}
	for i := range before {
		if before[i].Name != after[i].Name || before[i].ETag != after[i].ETag || before[i].Size != after[i].Size {
			return fail("file_changed")
		}
	}
	return nil
}
func validTransferPath(name string) error {
	if name == ".folio" {
		return nil
	}
	if strings.HasPrefix(name, ".folio/") {
		name = strings.TrimPrefix(name, ".folio/")
	}
	return ValidPath(name, false)
}
func transferTrashRecord(data []byte, name string) (trash.Record, error) {
	var rec trash.Record
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&rec) != nil || decoder.Decode(new(any)) != io.EOF || rec.State != "ready" || rec.ID != path.Base(path.Dir(name)) || !trash.ValidID(rec.ID) || ValidPath(rec.Path, false) != nil || (rec.Kind != "file" && rec.Kind != "directory") {
		return rec, errors.New("存在损坏或未完成的回收记录，请先在源后端处理")
	}
	return rec, nil
}
func transferDir(root *os.Root, name string) error {
	if name == "." {
		return nil
	}
	current := ""
	for _, part := range strings.Split(name, "/") {
		current = path.Join(current, part)
		if err := root.Mkdir(current, 0700); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		f, err := fileio.Open(root, current, os.O_RDONLY, 0)
		if err != nil {
			return err
		}
		info, err := f.Stat()
		f.Close()
		if err != nil {
			return err
		}
		if !info.IsDir() {
			return fail("target_exists")
		}
	}
	return nil
}
func readTransferFile(root *os.Root, name string) ([]byte, error) {
	f, err := fileio.Open(root, name, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if err = fileio.CheckSingleLink(f); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(f, (1<<30)+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 1<<30 {
		return nil, fail("too_large")
	}
	return data, nil
}
func writeTransferFile(root *os.Root, name string, data []byte) error {
	if err := transferDir(root, path.Dir(name)); err != nil {
		return err
	}
	if _, err := root.Lstat(name); err == nil {
		existing, e := readTransferFile(root, name)
		if e != nil {
			return e
		}
		if !bytes.Equal(existing, data) {
			return errors.New("目标文件与源内容不同，拒绝覆盖")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	parent, err := root.OpenRoot(path.Dir(name))
	if err != nil {
		return err
	}
	defer parent.Close()
	hash := sha256.Sum256([]byte(name))
	temp := ".folio-tmp-migrate-" + hex.EncodeToString(hash[:])
	if err = parent.Remove(temp); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	f, err := parent.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer parent.Remove(temp)
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		return err
	}
	if err = fileio.Rename(parent, temp, parent, path.Base(name)); err != nil {
		return err
	}
	return fileio.SyncRoot(parent)
}
