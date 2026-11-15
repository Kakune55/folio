package storage

import (
	"bytes"
	"encoding/json"
	"errors"
	"folio/internal/fileio"
	"folio/internal/trash"
	"io"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
)

// ImportLocalUser 仅供持有应用实例锁的离线命令使用，保留源文件并拒绝覆盖不同对象。
func (b *S3Backend) ImportLocalUser(directory string, id int64) error {
	return b.ImportLocalUserProgress(directory, id, nil)
}
func (b *S3Backend) ImportLocalUserProgress(directory string, id int64, report ProgressFunc) error {
	reportTransfer(report, id, "扫描", 0, 0)
	source, err := OpenManaged(directory, id)
	if err != nil {
		return err
	}
	defer source.Close()
	identity, err := source.Identity()
	if err != nil {
		return err
	}
	prefix := strconv.FormatInt(id, 10) + "/"
	if b.opts.Prefix != "" {
		prefix = b.opts.Prefix + "/" + prefix
	}
	r := &S3Store{backend: b, prefix: prefix, limits: Limits{Text: 100 << 20, Image: 1 << 30, PDF: 1 << 30, Attachment: 1 << 30, ImagePixels: 1_000_000_000}}
	marker, info, err := r.get(".folio/layout", 4096)
	var state map[string]string
	if isCode(err, "not_found") {
		all, e := r.objects()
		if e != nil {
			return e
		}
		if len(all) != 0 {
			return errors.New("迁移目标用户前缀非空，拒绝接管")
		}
		state = map[string]string{"format": "folio-s3-v1", "identity": identity, "importSource": identity, "import": "pending"}
		marker, _ = json.Marshal(state)
		info.ETag, err = r.put(".folio/layout", marker, "")
	} else if err == nil {
		if json.Unmarshal(marker, &state) != nil || state["format"] != "folio-s3-v1" || state["importSource"] != identity || state["identity"] != identity {
			return errors.New("迁移目标不是本工作区的未切换副本")
		}
	}
	if err != nil {
		return err
	}
	if err = r.probe(); err != nil {
		return err
	}
	before, err := localInventory(source.root)
	if err != nil {
		return err
	}
	expected := map[string]string{}
	for name, hash := range before {
		expected[name] = hash
	}
	total, done := len(before)-1, 0
	for _, name := range sortedKeys(before) {
		if name == ".folio/layout" {
			continue
		}
		var data []byte
		if !strings.HasSuffix(name, "/") {
			f, e := fileio.Open(source.root, name, os.O_RDONLY, 0)
			if e != nil {
				return e
			}
			if e = fileio.CheckSingleLink(f); e != nil {
				f.Close()
				return e
			}
			data, e = io.ReadAll(io.LimitReader(f, (1<<30)+1))
			f.Close()
			if e != nil {
				return e
			}
			if len(data) > 1<<30 {
				return fail("too_large")
			}
			if strings.HasPrefix(name, ".folio/trash/") && strings.HasSuffix(name, "/record.json") {
				var rec trash.Record
				decoder := json.NewDecoder(bytes.NewReader(data))
				decoder.DisallowUnknownFields()
				if decoder.Decode(&rec) != nil || decoder.Decode(new(any)) != io.EOF || rec.State != "ready" || !trash.ValidID(rec.ID) || rec.ID != path.Base(path.Dir(name)) || ValidPath(rec.Path, false) != nil || (rec.Kind != "file" && rec.Kind != "directory") {
					return errors.New("存在损坏或未完成的本地回收记录，请先在 local 模式处理")
				}
				if rec.Kind == "directory" {
					rev, _, e := r.payloadRevision(path.Dir(name) + "/payload")
					if e != nil {
						return e
					}
					rec.Revision = rev
					data, e = json.Marshal(rec)
					if e != nil {
						return e
					}
					expected[name] = digest(data)
				}
			}
		}
		old, _, e := r.get(name, 1<<30)
		if e == nil {
			if digest(old) != digest(data) {
				return errors.New("目标对象与原件不同，拒绝覆盖")
			}
		} else if isCode(e, "not_found") {
			if _, e = r.put(name, data, ""); e != nil {
				return e
			}
		} else {
			return e
		}
		done++
		reportTransfer(report, id, "复制", done, total)
	}
	after, err := localInventory(source.root)
	if err != nil {
		return err
	}
	if len(before) != len(after) {
		return errors.New("迁移期间源目录发生变化")
	}
	for k, v := range before {
		if after[k] != v {
			return errors.New("迁移期间源内容发生变化")
		}
	}
	all, err := r.objects()
	if err != nil {
		return err
	}
	verified := 0
	for _, o := range all {
		if o.Name == ".folio/layout" {
			continue
		}
		if _, ok := before[o.Name]; !ok {
			return errors.New("迁移目标含额外对象，拒绝切换")
		}
		data, _, e := r.get(o.Name, 1<<30)
		if e != nil {
			return e
		}
		if digest(data) != expected[o.Name] {
			return errors.New("迁移对象校验失败")
		}
		verified++
		reportTransfer(report, id, "校验", verified, total)
	}
	// 切换到核心库前先完成每个用户标记；核心库绑定仍阻止普通启动误用半份数据。
	state["import"] = "done"
	marker, _ = json.Marshal(state)
	_, err = r.put(".folio/layout", marker, info.ETag)
	return err
}
func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
func localInventory(root *os.Root) (map[string]string, error) {
	result := map[string]string{}
	var walk func(string) error
	walk = func(name string) error {
		f, err := fileio.Open(root, name, os.O_RDONLY, 0)
		if err != nil {
			return err
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			return err
		}
		if info.IsDir() {
			if name != "." {
				result[name+"/"] = digest(nil)
			}
			entries, err := f.ReadDir(-1)
			if err != nil {
				return err
			}
			for _, e := range entries {
				if err = walk(path.Join(name, e.Name())); err != nil {
					return err
				}
			}
			return nil
		}
		if err = fileio.CheckSingleLink(f); err != nil {
			return err
		}
		if info.Size() > 1<<30 {
			return fail("too_large")
		}
		data, err := io.ReadAll(io.LimitReader(f, (1<<30)+1))
		if err != nil {
			return err
		}
		if len(data) > 1<<30 {
			return fail("too_large")
		}
		result[name] = digest(data)
		return nil
	}
	if err := walk("."); err != nil {
		return nil, err
	}
	return result, nil
}
