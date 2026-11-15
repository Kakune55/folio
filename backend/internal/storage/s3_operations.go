package storage

import (
	"encoding/json"
	"errors"
	"folio/internal/trash"
	"path"
	"sort"
	"strings"
	"time"
)

type s3Item struct{ Source, SourceETag, Target, Hash string }
type s3Operation struct {
	ID, Kind, SourcePrefix, TargetPrefix, RemoveRecord, RemoveETag string
	Items                                                          []s3Item
	Trash                                                          *trash.Record
}

func (r *S3Store) run(op s3Operation) error {
	data, err := json.Marshal(op)
	if err != nil {
		return err
	}
	if len(data) > 32<<20 {
		return fail("too_large")
	}
	name := ".folio/operations/" + op.ID + ".json"
	tag, err := r.put(name, data, "")
	if err != nil {
		r.blocked = true
		return err
	}
	r.blocked = true
	if err = r.resume(op, name, tag); err != nil {
		return err
	}
	r.blocked = false
	return nil
}
func (r *S3Store) recover() error {
	all, err := r.objects()
	if err != nil {
		return err
	}
	for _, o := range all {
		if strings.HasSuffix(o.Name, "/") {
			if o.Size != 0 {
				return fail("unsupported_file_type")
			}
			continue
		}
		if !strings.HasPrefix(o.Name, ".folio/operations/") {
			continue
		}
		data, info, e := r.get(o.Name, 32<<20)
		if e != nil {
			return e
		}
		var op s3Operation
		if json.Unmarshal(data, &op) != nil || op.ID == "" || o.Name != ".folio/operations/"+op.ID+".json" {
			return errors.New("恢复记录无效，保留现场")
		}
		if e = r.validateOperation(op); e != nil {
			return e
		}
		if e = r.resume(op, o.Name, info.ETag); e != nil {
			return e
		}
	}
	r.blocked = false
	return nil
}
func (r *S3Store) validateOperation(op s3Operation) error {
	if !trash.ValidID(op.ID) || len(op.Items) == 0 {
		return errors.New("恢复记录没有文件")
	}
	switch op.Kind {
	case "move", "trash", "restore", "publish":
	default:
		return errors.New("恢复记录操作类型无效")
	}
	if op.TargetPrefix == "" {
		return errors.New("恢复记录缺少目标范围")
	}
	switch op.Kind {
	case "move":
		if !public(op.SourcePrefix) || !public(op.TargetPrefix) || op.SourcePrefix == op.TargetPrefix || strings.HasPrefix(op.TargetPrefix, op.SourcePrefix+"/") {
			return errors.New("移动恢复范围无效")
		}
	case "trash":
		if op.Trash == nil || !trash.ValidID(op.Trash.ID) || ValidPath(op.Trash.Path, false) != nil || op.SourcePrefix != op.Trash.Path || op.TargetPrefix != ".folio/trash/"+op.Trash.ID+"/payload" {
			return errors.New("回收恢复范围无效")
		}
	case "restore":
		parts := strings.Split(op.SourcePrefix, "/")
		if len(parts) != 4 || parts[0] != ".folio" || parts[1] != "trash" || !trash.ValidID(parts[2]) || parts[3] != "payload" || !public(op.TargetPrefix) || op.RemoveRecord != ".folio/trash/"+parts[2]+"/record.json" || op.RemoveETag == "" {
			return errors.New("还原恢复范围无效")
		}
	case "publish":
		if op.SourcePrefix != ".folio/staging/"+op.ID {
			return errors.New("发布暂存范围无效")
		}
		if !public(op.TargetPrefix) {
			parts := strings.Split(op.TargetPrefix, "/")
			if len(parts) != 3 || parts[0] != ".folio" || parts[1] != "shares" || snapshotName(parts[2]) != nil {
				return errors.New("发布目标范围无效")
			}
		}
	}
	for _, i := range op.Items {
		for _, name := range []string{i.Source, i.Target} {
			clean := strings.TrimSuffix(name, "/")
			if clean == "" || path.Clean(clean) != clean || strings.HasPrefix(clean, "/") || strings.ContainsAny(clean, "\\\x00") {
				return errors.New("恢复记录含越界路径")
			}
		}
		if i.Source != op.SourcePrefix && !strings.HasPrefix(i.Source, op.SourcePrefix+"/") {
			return errors.New("恢复源越出操作范围")
		}
		if op.Kind == "publish" {
			if !strings.HasPrefix(i.Target, op.TargetPrefix+"/") || ValidPath(strings.TrimPrefix(i.Target, op.TargetPrefix+"/"), false) != nil {
				return errors.New("发布文件越出目标范围")
			}
		} else if i.Target != op.TargetPrefix+strings.TrimPrefix(i.Source, op.SourcePrefix) {
			return errors.New("恢复目标与源清单不匹配")
		}
		if i.Source == i.Target || i.SourceETag == "" || !strings.HasPrefix(i.Hash, "sha256:") {
			return errors.New("恢复记录缺少原版本")
		}
	}
	return nil
}
func (r *S3Store) resume(op s3Operation, journal, tag string) error {
	if err := r.validateOperation(op); err != nil {
		return err
	}
	for _, item := range op.Items {
		source, info, se := r.get(item.Source, int64(1<<30))
		if se == nil && (info.ETag != item.SourceETag || digest(source) != item.Hash) {
			return fail("file_changed")
		}
		if se != nil && !isCode(se, "not_found") {
			return se
		}
		target, _, te := r.get(item.Target, int64(1<<30))
		if te == nil {
			if digest(target) != item.Hash {
				return fail("revision_conflict")
			}
			continue
		}
		if !isCode(te, "not_found") {
			return te
		}
		if se != nil {
			return fail("file_changed")
		}
		if _, err := r.put(item.Target, source, ""); err != nil {
			return err
		}
	}
	// 所有目标完整后才开始删除源；每次删除同时固定源 ETag。
	for _, item := range op.Items {
		target, _, err := r.get(item.Target, int64(1<<30))
		if err != nil {
			return err
		}
		if digest(target) != item.Hash {
			return fail("revision_conflict")
		}
		_, source, err := r.get(item.Source, int64(1<<30))
		if isCode(err, "not_found") {
			continue
		}
		if err != nil {
			return err
		}
		if source.ETag != item.SourceETag {
			return fail("revision_conflict")
		}
		if err = r.del(item.Source, item.SourceETag); err != nil {
			return err
		}
	}
	if op.SourcePrefix != "" {
		all, err := r.objects()
		if err != nil {
			return err
		}
		for _, o := range all {
			if o.Name == op.SourcePrefix || strings.HasPrefix(o.Name, strings.TrimSuffix(op.SourcePrefix, "/")+"/") {
				return fail("file_changed")
			}
		}
	}
	if op.Trash != nil {
		name := ".folio/trash/" + op.Trash.ID + "/record.json"
		data, _ := json.Marshal(op.Trash)
		old, _, err := r.get(name, 65536)
		if err == nil {
			if string(old) != string(data) {
				return fail("revision_conflict")
			}
		} else if isCode(err, "not_found") {
			if _, err = r.put(name, data, ""); err != nil {
				return err
			}
		} else {
			return err
		}
	}
	if op.RemoveRecord != "" {
		_, o, err := r.get(op.RemoveRecord, 65536)
		if err == nil {
			if o.ETag != op.RemoveETag {
				return fail("revision_conflict")
			}
			if err = r.del(op.RemoveRecord, o.ETag); err != nil {
				return err
			}
		} else if !isCode(err, "not_found") {
			return err
		}
	}
	return r.del(journal, tag)
}
func (r *S3Store) movePlan(from, to, kind string) (s3Operation, error) {
	all, err := r.objects()
	if err != nil {
		return s3Operation{}, err
	}
	op := s3Operation{ID: nonce(), Kind: kind, SourcePrefix: from, TargetPrefix: to}
	for _, o := range all {
		if o.Name != from && !strings.HasPrefix(o.Name, from+"/") {
			continue
		}
		data, info, err := r.get(o.Name, int64(1<<30))
		if err != nil {
			return op, err
		}
		target := to + strings.TrimPrefix(o.Name, from)
		if (kind == "move" || kind == "trash") && !public(o.Name) || kind == "restore" && !public(target) {
			return op, fail("path_invalid")
		}
		op.Items = append(op.Items, s3Item{o.Name, info.ETag, target, digest(data)})
	}
	if !trash.ValidID(op.ID) || len(op.Items) == 0 {
		return op, fail("not_found")
	}
	for _, i := range op.Items {
		for _, o := range all {
			if o.Name == i.Target {
				return op, fail("target_exists")
			}
		}
	}
	return op, nil
}
func (r *S3Store) Move(from, to, revision string) error {
	if ValidPath(from, false) != nil || ValidPath(to, false) != nil || from == to || strings.HasPrefix(to, from+"/") {
		return fail("path_invalid")
	}
	if revision == "" {
		return fail("precondition_required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(); err != nil {
		return err
	}
	nodes, err := r.tree()
	if err != nil {
		return err
	}
	if _, ok := nodes[to]; ok {
		return fail("target_exists")
	}
	if err = r.parent(nodes, to); err != nil {
		return err
	}
	current, _, err := r.revision(nodes, from)
	if err != nil {
		return err
	}
	if current != revision {
		return &Error{Code: "revision_conflict", Revision: current}
	}
	op, err := r.movePlan(from, to, "move")
	if err != nil {
		return err
	}
	return r.run(op)
}
func (r *S3Store) Trash(name, revision string) (*trash.Record, error) {
	if err := ValidPath(name, false); err != nil {
		return nil, err
	}
	if revision == "" {
		return nil, fail("precondition_required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(); err != nil {
		return nil, err
	}
	nodes, err := r.tree()
	if err != nil {
		return nil, err
	}
	current, kind, err := r.revision(nodes, name)
	if err != nil {
		return nil, err
	}
	if current != revision {
		return nil, &Error{Code: "revision_conflict", Revision: current}
	}
	rec := &trash.Record{ID: nonce(), Path: name, Kind: kind, Revision: revision, DeletedAt: time.Now().UTC().Format(time.RFC3339Nano), State: "ready"}
	op, err := r.movePlan(name, ".folio/trash/"+rec.ID+"/payload", "trash")
	if err != nil {
		return nil, err
	}
	op.Trash = rec
	if err = r.run(op); err != nil {
		return rec, err
	}
	return rec, nil
}
func (r *S3Store) trashRecord(id string) (trash.Record, s3Object, error) {
	if !trash.ValidID(id) {
		return trash.Record{}, s3Object{}, fail("trash_not_found")
	}
	data, o, err := r.get(".folio/trash/"+id+"/record.json", 65536)
	if isCode(err, "not_found") {
		return trash.Record{}, o, fail("trash_not_found")
	}
	if err != nil {
		return trash.Record{}, o, err
	}
	var rec trash.Record
	if json.Unmarshal(data, &rec) != nil || rec.ID != id || ValidPath(rec.Path, false) != nil || rec.State != "ready" {
		return rec, o, fail("trash_damaged")
	}
	return rec, o, nil
}
func (r *S3Store) TrashList(offset, limit int) ([]trash.Record, int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(); err != nil {
		return nil, 0, err
	}
	all, err := r.objects()
	if err != nil {
		return nil, 0, err
	}
	records := []trash.Record{}
	for _, o := range all {
		if !strings.HasPrefix(o.Name, ".folio/trash/") || !strings.HasSuffix(o.Name, "/record.json") {
			continue
		}
		id := path.Base(path.Dir(o.Name))
		rec, _, e := r.trashRecord(id)
		if e != nil {
			return nil, 0, e
		}
		records = append(records, rec)
	}
	sortTrash(records)
	n := len(records)
	offset = min(max(offset, 0), n)
	return records[offset:min(offset+max(limit, 0), n)], n, nil
}
func (r *S3Store) Restore(id string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(); err != nil {
		return "", err
	}
	rec, o, err := r.trashRecord(id)
	if err != nil {
		return "", err
	}
	nodes, err := r.tree()
	if err != nil {
		return "", err
	}
	if _, ok := nodes[rec.Path]; ok {
		return "", fail("target_exists")
	}
	if err = r.parent(nodes, rec.Path); err != nil {
		return "", err
	}
	actual, _, err := r.payloadRevision(".folio/trash/" + id + "/payload")
	if err != nil {
		return "", err
	}
	if actual != rec.Revision {
		return "", fail("trash_damaged")
	}
	op, err := r.movePlan(".folio/trash/"+id+"/payload", rec.Path, "restore")
	if err != nil {
		return "", err
	}
	op.RemoveRecord = ".folio/trash/" + id + "/record.json"
	op.RemoveETag = o.ETag
	if err = r.run(op); err != nil {
		return "", err
	}
	return rec.Path, nil
}
func (r *S3Store) Purge(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(); err != nil {
		return err
	}
	_, record, err := r.trashRecord(id)
	if err != nil {
		return err
	}
	if err = r.removePrefix(".folio/trash/" + id + "/payload/"); err != nil {
		return err
	}
	_, o, err := r.get(".folio/trash/"+id+"/payload", int64(1<<30))
	if err == nil {
		if err = r.del(o.Name, o.ETag); err != nil {
			return err
		}
	} else if !isCode(err, "not_found") {
		return err
	}
	return r.del(record.Name, record.ETag)
}
func sortTrash(records []trash.Record) {
	sort.Slice(records, func(i, j int) bool { return records[i].DeletedAt > records[j].DeletedAt })
}

func (r *S3Store) payloadRevision(prefix string) (string, string, error) {
	all, err := r.objects()
	if err != nil {
		return "", "", err
	}
	nodes := map[string]s3Object{}
	for _, o := range all {
		if o.Name != prefix && !strings.HasPrefix(o.Name, prefix+"/") {
			continue
		}
		name := strings.TrimSuffix(o.Name, "/")
		if name != prefix && ValidPath(strings.TrimPrefix(name, prefix+"/"), false) != nil {
			return "", "", fail("path_invalid")
		}
		if old, ok := nodes[name]; ok && strings.HasSuffix(old.Name, "/") != strings.HasSuffix(o.Name, "/") {
			return "", "", fail("trash_damaged")
		}
		nodes[name] = o
		for p := path.Dir(name); p == prefix || strings.HasPrefix(p, prefix+"/"); p = path.Dir(p) {
			if old, ok := nodes[p]; ok && !strings.HasSuffix(old.Name, "/") {
				return "", "", fail("trash_damaged")
			}
			if _, ok := nodes[p]; !ok {
				nodes[p] = s3Object{Name: p + "/"}
			}
		}
	}
	return r.revision(nodes, prefix)
}
