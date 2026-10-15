// Package trash 保存普通文件恢复记录；正文不进入数据库。
package trash

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"golang.org/x/sys/unix"
	"io"
	"os"
	"path"
	"sort"
	"strings"
	"time"
)

type Record struct {
	ID        string `json:"id"`
	Path      string `json:"path"`
	Kind      string `json:"kind"`
	Revision  string `json:"revision"`
	DeletedAt string `json:"deletedAt"`
	State     string `json:"state"`
	Stage     string `json:"stage,omitempty"`
}
type Repository struct{ root *os.Root }

func ValidID(id string) bool {
	data, err := hex.DecodeString(id)
	return err == nil && len(data) == 16 && len(id) == 32
}
func Open(directory string) (*Repository, error) {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, err
	}
	return &Repository{root: root}, nil
}
func (r *Repository) Close() error { return r.root.Close() }
func (r *Repository) Directory(id string) (*os.Root, error) {
	if !ValidID(id) {
		return nil, errors.New("恢复记录编号无效")
	}
	return r.root.OpenRoot(id)
}
func (r *Repository) Create(original, kind, revision string) (Record, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return Record{}, err
	}
	id := hex.EncodeToString(bytes[:])
	record := Record{ID: id, Path: original, Kind: kind, Revision: revision, DeletedAt: time.Now().UTC().Format(time.RFC3339Nano), State: "preparing", Stage: path.Join(path.Dir(original), ".folio-tmp-trash-"+id)}
	if err := r.root.Mkdir(id, 0o700); err != nil {
		return Record{}, err
	}
	if err := r.Write(record); err != nil {
		return Record{}, err
	}
	if err := syncRoot(r.root); err != nil {
		return Record{}, err
	}
	return record, nil
}
func (r *Repository) Write(record Record) error {
	dir, err := r.Directory(record.ID)
	if err != nil {
		return err
	}
	defer dir.Close()
	var bytes [8]byte
	if _, err = rand.Read(bytes[:]); err != nil {
		return err
	}
	temp := "record-" + hex.EncodeToString(bytes[:]) + ".tmp"
	file, err := dir.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer func() { file.Close(); _ = dir.Remove(temp) }()
	if err = json.NewEncoder(file).Encode(record); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	if err = dir.Rename(temp, "record.json"); err != nil {
		return err
	}
	return syncRoot(dir)
}
func (r *Repository) Read(id string) (Record, error) {
	dir, err := r.Directory(id)
	if err != nil {
		return Record{}, err
	}
	defer dir.Close()
	file, err := dir.OpenFile("record.json", os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return Record{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 65536 {
		return Record{}, errors.New("恢复记录不是有效的普通文件")
	}
	decoder := json.NewDecoder(io.LimitReader(file, 65537))
	decoder.DisallowUnknownFields()
	var record Record
	if err = decoder.Decode(&record); err != nil {
		return Record{}, err
	}
	if record.ID != id || record.Path == "" || len(record.Revision) != 71 || !strings.HasPrefix(record.Revision, "sha256:") || (record.Kind != "file" && record.Kind != "directory") {
		return Record{}, errors.New("恢复记录损坏")
	}
	var extra any
	if err = decoder.Decode(&extra); err != io.EOF {
		return Record{}, errors.New("恢复记录包含额外内容")
	}
	return record, nil
}
func (r *Repository) List(offset, limit int) ([]Record, int, error) {
	dir, err := r.root.Open(".")
	if err != nil {
		return nil, 0, err
	}
	defer dir.Close()
	entries, err := dir.ReadDir(-1)
	if err != nil {
		return nil, 0, err
	}
	records := []Record{}
	for _, entry := range entries {
		if !entry.IsDir() || !ValidID(entry.Name()) {
			continue
		}
		record, err := r.Read(entry.Name())
		if err != nil {
			record = Record{ID: entry.Name(), Path: "恢复记录无法读取", State: "damaged"}
		}
		if record.State != "restored" && record.State != "rolled_back" {
			records = append(records, record)
		}
	}
	sort.Slice(records, func(i, j int) bool { return records[i].DeletedAt > records[j].DeletedAt })
	total := len(records)
	offset = min(offset, total)
	return records[offset:min(offset+limit, total)], total, nil
}
func (r *Repository) Remove(id string) error {
	if !ValidID(id) {
		return errors.New("恢复记录编号无效")
	}
	if err := r.root.RemoveAll(id); err != nil {
		return err
	}
	return syncRoot(r.root)
}
func syncRoot(root *os.Root) error {
	dir, err := root.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
