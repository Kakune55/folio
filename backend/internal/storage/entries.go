package storage

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path"
	"runtime"
	"sort"
	"strings"

	"folio/internal/fileio"
	"folio/internal/trash"
)

type EntryRevision struct {
	Path     string `json:"path"`
	Kind     string `json:"kind"`
	Revision string `json:"revision"`
}
type opener func(string) (*os.File, error)

func (s *Store) SetTrash(repository *trash.Repository) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.trash = repository
}
func (s *Store) fileOpener(name string) (*os.File, error) { return s.open(name, os.O_RDONLY, 0) }
func revisionOf(open opener, name string) (string, string, error) {
	file, err := open(name)
	if err != nil {
		return "", "", err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", "", err
	}
	if !info.IsDir() {
		if _, err = regular(file); err != nil {
			return "", "", err
		}
		sum := sha256.New()
		if _, err = io.Copy(sum, file); err != nil {
			return "", "", err
		}
		if err = unchanged(file, info); err != nil {
			return "", "", err
		}
		return "sha256:" + hex.EncodeToString(sum.Sum(nil)), "file", nil
	}
	entries, err := file.ReadDir(-1)
	if err != nil {
		return "", "", err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	sum := sha256.New()
	_, _ = fmt.Fprintf(sum, "directory:%o\x00", info.Mode().Perm())
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 {
			return "", "", fail("unsupported_file_type")
		}
		if ValidPath(entry.Name(), false) != nil {
			return "", "", fail("operation_in_progress")
		}
		revision, kind, err := revisionOf(open, path.Join(name, entry.Name()))
		if err != nil {
			return "", "", err
		}
		addChild(sum, entry.Name(), kind, revision)
	}
	if err = unchanged(file, info); err != nil {
		return "", "", err
	}
	return "sha256:" + hex.EncodeToString(sum.Sum(nil)), "directory", nil
}
func addChild(sum hash.Hash, name, kind, revision string) {
	_, _ = fmt.Fprintf(sum, "%d:%s\x00%s\x00%s\x00", len(name), name, kind, revision)
}
func unchanged(file *os.File, before os.FileInfo) error {
	after, err := file.Stat()
	if err != nil {
		return err
	}
	if before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		return fail("file_changed")
	}
	return nil
}
func (s *Store) EntryRevision(name string) (*EntryRevision, error) {
	if err := ValidPath(name, false); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	revision, kind, err := revisionOf(s.fileOpener, name)
	if err != nil {
		return nil, err
	}
	return &EntryRevision{Path: name, Kind: kind, Revision: revision}, nil
}
func (s *Store) checkUploads(name string) error {
	for filename, count := range s.uploads {
		if count > 0 && (filename == name || strings.HasPrefix(filename, name+"/")) {
			return fail("operation_in_progress")
		}
	}
	return nil
}
func (s *Store) verifyParent(name string, parent *os.Root) error {
	current, _, err := s.parent(name)
	if err != nil {
		return err
	}
	defer current.Close()
	a, errA := fileio.Stat(parent)
	b, errB := fileio.Stat(current)
	if errA != nil || errB != nil || !os.SameFile(a, b) {
		return fail("file_changed")
	}
	return nil
}
func (s *Store) Move(from, to, revision string) error {
	if err := ValidPath(from, false); err != nil {
		return err
	}
	if err := ValidPath(to, false); err != nil {
		return err
	}
	if from == to || strings.HasPrefix(to, from+"/") {
		return fail("path_invalid")
	}
	if revision == "" {
		return fail("precondition_required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkUploads(from); err != nil {
		return err
	}
	if err := s.checkUploads(to); err != nil {
		return err
	}
	current, _, err := revisionOf(s.fileOpener, from)
	if err != nil {
		return err
	}
	if current != revision {
		return &Error{Code: "revision_conflict", Revision: current}
	}
	parent, base, err := s.parent(from)
	if err != nil {
		return err
	}
	defer parent.Close()
	destination, target, err := s.parent(to)
	if err != nil {
		return err
	}
	defer destination.Close()
	if err = s.verifyParent(from, parent); err != nil {
		return err
	}
	if err = s.verifyParent(to, destination); err != nil {
		return err
	}
	if err = fileio.Rename(parent, base, destination, target); err != nil {
		return mapError(err)
	}
	if err = fileio.SyncRoot(parent); err != nil {
		return fail("durability_uncertain")
	}
	if err = fileio.SyncRoot(destination); err != nil {
		return fail("durability_uncertain")
	}
	return nil
}

// copyEntry 只复制已校验的普通文件/目录，边复制边计算与条件版本一致的内容摘要。
func copyEntry(open opener, source string, destination *os.Root, target string) (string, string, error) {
	file, err := open(source)
	if err != nil {
		return "", "", err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", "", err
	}
	if !info.IsDir() {
		if _, err = regular(file); err != nil {
			return "", "", err
		}
		output, err := destination.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return "", "", mapError(err)
		}
		defer output.Close()
		sum := sha256.New()
		if _, err = io.Copy(io.MultiWriter(output, sum), file); err != nil {
			return "", "", err
		}
		if err = unchanged(file, info); err != nil {
			return "", "", err
		}
		if err = output.Chmod(info.Mode().Perm()); err != nil {
			return "", "", err
		}
		if err = output.Sync(); err != nil {
			return "", "", err
		}
		if err = output.Close(); err != nil {
			return "", "", err
		}
		return "sha256:" + hex.EncodeToString(sum.Sum(nil)), "file", nil
	}
	if err = destination.Mkdir(target, 0o700); err != nil {
		return "", "", mapError(err)
	}
	entries, err := file.ReadDir(-1)
	if err != nil {
		return "", "", err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	sum := sha256.New()
	_, _ = fmt.Fprintf(sum, "directory:%o\x00", info.Mode().Perm())
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 {
			return "", "", fail("unsupported_file_type")
		}
		if ValidPath(entry.Name(), false) != nil {
			return "", "", fail("operation_in_progress")
		}
		revision, kind, err := copyEntry(open, path.Join(source, entry.Name()), destination, path.Join(target, entry.Name()))
		if err != nil {
			return "", "", err
		}
		addChild(sum, entry.Name(), kind, revision)
	}
	if err = unchanged(file, info); err != nil {
		return "", "", err
	}
	dir, err := destination.Open(target)
	if err != nil {
		return "", "", err
	}
	defer dir.Close()
	if err = dir.Chmod(info.Mode().Perm()); err != nil {
		return "", "", err
	}
	if err = fileio.Sync(dir); err != nil {
		return "", "", err
	}
	return "sha256:" + hex.EncodeToString(sum.Sum(nil)), "directory", nil
}
func rootOpener(root *os.Root) opener {
	return func(name string) (*os.File, error) {
		file, err := fileio.Open(root, name, os.O_RDONLY, 0)
		return file, mapError(err)
	}
}

func (s *Store) syncEntry(name string) error {
	file, err := s.fileOpener(name)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if info.IsDir() {
		entries, err := file.ReadDir(-1)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if entry.Type()&os.ModeSymlink != 0 || ValidPath(entry.Name(), false) != nil {
				return fail("unsupported_file_type")
			}
			if err = s.syncEntry(path.Join(name, entry.Name())); err != nil {
				return err
			}
		}
	} else if _, err = regular(file); err != nil {
		return err
	}
	// Windows 的 FlushFileBuffers 要求可写文件句柄；目录不套用此要求。
	if runtime.GOOS == "windows" && info.Mode().IsRegular() {
		writable, err := s.open(name, os.O_RDWR, 0)
		if err != nil {
			return err
		}
		defer writable.Close()
		current, err := writable.Stat()
		if err != nil {
			return err
		}
		if !os.SameFile(info, current) {
			return fail("file_changed")
		}
		return writable.Sync()
	}
	return fileio.Sync(file)
}

func (s *Store) Trash(name, revision string) (*trash.Record, error) {
	if err := ValidPath(name, false); err != nil {
		return nil, err
	}
	if revision == "" {
		return nil, fail("precondition_required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.trash == nil {
		return nil, fail("trash_unavailable")
	}
	if err := s.checkUploads(name); err != nil {
		return nil, err
	}
	current, kind, err := revisionOf(s.fileOpener, name)
	if err != nil {
		return nil, err
	}
	if current != revision {
		return nil, &Error{Code: "revision_conflict", Revision: current}
	}
	parent, base, err := s.parent(name)
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	if err = s.syncEntry(name); err != nil {
		return nil, err
	}
	record, err := s.trash.Create(name, kind, revision)
	if err != nil {
		return nil, err
	}
	data, err := s.trash.Directory(record.ID)
	if err != nil {
		return &record, err
	}
	defer data.Close()
	dir, err := data.Open(".")
	if err != nil {
		return &record, err
	}
	defer dir.Close()
	if err = s.verifyParent(name, parent); err != nil {
		return &record, err
	}
	latest, _, checkErr := revisionOf(s.fileOpener, name)
	if checkErr != nil || latest != revision {
		_ = s.trash.Remove(record.ID)
		if checkErr != nil {
			return nil, checkErr
		}
		return nil, &Error{Code: "revision_conflict", Revision: latest}
	}
	err = fileio.Rename(parent, base, data, "payload")
	if err == nil {
		if err = fileio.SyncRoot(parent); err != nil {
			return &record, fail("durability_uncertain")
		}
		if err = fileio.Sync(dir); err != nil {
			return &record, fail("durability_uncertain")
		}
		record.Stage = ""
		record.State = "ready"
		if err = s.trash.Write(record); err != nil {
			return &record, fail("durability_uncertain")
		}
		return &record, nil
	}
	if !fileio.CrossDevice(err) {
		_ = s.trash.Remove(record.ID)
		return nil, mapError(err)
	}
	// 两个持久卷可以位于不同文件系统：先原地隔离，再复制落盘，最后才清理隔离原件。
	stage := path.Base(record.Stage)
	if err = fileio.Rename(parent, base, parent, stage); err != nil {
		_ = s.trash.Remove(record.ID)
		return nil, mapError(err)
	}
	if err = fileio.SyncRoot(parent); err != nil {
		return &record, fail("durability_uncertain")
	}
	copied, _, copyErr := copyEntry(s.fileOpener, record.Stage, data, "payload")
	if copyErr != nil || copied != revision {
		if copyErr == nil {
			copyErr = fail("file_changed")
		}
		rollback := fileio.Rename(parent, stage, parent, base)
		if rollback == nil {
			_ = fileio.SyncRoot(parent)
			_ = s.trash.Remove(record.ID)
			return nil, fmt.Errorf("%w: %v", fail("trash_failed"), copyErr)
		}
		record.State = "incomplete"
		_ = s.trash.Write(record)
		return &record, fmt.Errorf("%w: copy=%v rollback=%v", fail("trash_incomplete"), copyErr, rollback)
	}
	if err = fileio.Sync(dir); err != nil {
		return &record, fail("durability_uncertain")
	}
	record.State = "ready"
	if err = s.trash.Write(record); err != nil {
		return &record, fail("durability_uncertain")
	}
	verified, _, err := revisionOf(s.fileOpener, record.Stage)
	if err != nil || verified != revision {
		record.State = "incomplete"
		_ = s.trash.Write(record)
		return &record, fail("trash_incomplete")
	}
	// 私密隔离名称只能由服务创建；删除不跟随符号链接，仍限定在工作区根目录。
	if err = s.root.RemoveAll(record.Stage); err != nil {
		return &record, fail("trash_incomplete")
	}
	if err = fileio.SyncRoot(parent); err != nil {
		return &record, fail("durability_uncertain")
	}
	record.Stage = ""
	if err = s.trash.Write(record); err != nil {
		return &record, fail("durability_uncertain")
	}
	return &record, nil
}
func (s *Store) TrashList(offset, limit int) ([]trash.Record, int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.trash == nil {
		return nil, 0, fail("trash_unavailable")
	}
	return s.trash.List(offset, limit)
}
func (s *Store) Restore(id string) (string, error) {
	if !trash.ValidID(id) {
		return "", fail("path_invalid")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.trash == nil {
		return "", fail("trash_unavailable")
	}
	record, err := s.trash.Read(id)
	if err != nil {
		return "", fail("trash_damaged")
	}
	if ValidPath(record.Path, false) != nil || (record.State != "ready" && record.State != "preparing" && record.State != "incomplete") {
		return "", fail("trash_damaged")
	}
	expectedStage := path.Join(path.Dir(record.Path), ".folio-tmp-trash-"+record.ID)
	if record.Stage != "" && record.Stage != expectedStage {
		return "", fail("trash_damaged")
	}
	if err = s.checkUploads(record.Path); err != nil {
		return "", err
	}
	parent, base, err := s.parent(record.Path)
	if err != nil {
		return "", err
	}
	defer parent.Close()
	// 恢复碰撞必须失败，绝不覆盖后来创建的同名文件。
	if _, err = parent.Lstat(base); err == nil {
		return "", fail("target_exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", mapError(err)
	}
	data, err := s.trash.Directory(id)
	if err != nil {
		return "", fail("trash_damaged")
	}
	defer data.Close()
	if record.Stage != "" {
		if file, stageErr := s.fileOpener(record.Stage); stageErr == nil {
			file.Close()
			stageRevision, _, verifyErr := revisionOf(s.fileOpener, record.Stage)
			if verifyErr != nil || stageRevision != record.Revision {
				return "", fail("trash_incomplete")
			}
			if err = s.verifyParent(record.Path, parent); err != nil {
				return "", err
			}
			if err = fileio.Rename(parent, path.Base(record.Stage), parent, base); err != nil {
				return "", mapError(err)
			}
			if err = fileio.SyncRoot(parent); err != nil {
				return "", fail("durability_uncertain")
			}
			record.State = "restored"
			if err = s.trash.Write(record); err != nil {
				return "", fail("durability_uncertain")
			}
			// 若隔离原件在故障期间改变，保留旧副本供管理员核查；不主动删除另一版本。
			if current, _, checkErr := revisionOf(s.fileOpener, record.Path); checkErr == nil && current == record.Revision {
				_ = s.trash.Remove(id)
			}
			return record.Path, nil
		} else {
			var missing *Error
			if !errors.As(stageErr, &missing) || missing.Code != "not_found" {
				return "", fail("trash_incomplete")
			}
		}
	}
	current, _, err := revisionOf(rootOpener(data), "payload")
	if err != nil || current != record.Revision {
		return "", fail("trash_damaged")
	}
	dir, err := data.Open(".")
	if err != nil {
		return "", err
	}
	defer dir.Close()
	if err = s.verifyParent(record.Path, parent); err != nil {
		return "", err
	}
	err = fileio.Rename(data, "payload", parent, base)
	if fileio.CrossDevice(err) {
		// 新建独占容器，只清理本次创建的临时副本，不能删除其他故障遗留版本。
		var nonce [16]byte
		if _, err = rand.Read(nonce[:]); err != nil {
			return "", err
		}
		temporary := ".folio-tmp-restore-" + hex.EncodeToString(nonce[:])
		if err = parent.Mkdir(temporary, 0o700); err != nil {
			return "", mapError(err)
		}
		temporaryRoot, openErr := parent.OpenRoot(temporary)
		if openErr != nil {
			return "", openErr
		}
		defer temporaryRoot.Close()
		cleanup := func() {
			_ = temporaryRoot.RemoveAll("payload")
			_ = parent.Remove(temporary)
		}
		copied, _, copyErr := copyEntry(rootOpener(data), "payload", temporaryRoot, "payload")
		if copyErr != nil || copied != record.Revision {
			cleanup()
			return "", fail("trash_failed")
		}
		if err = fileio.SyncRoot(temporaryRoot); err != nil {
			cleanup()
			return "", fail("durability_uncertain")
		}
		if err = s.verifyParent(record.Path, parent); err != nil {
			cleanup()
			return "", err
		}
		err = fileio.Rename(temporaryRoot, "payload", parent, base)
		if err != nil {
			cleanup()
			return "", mapError(err)
		}
		cleanup()
	}
	if err != nil {
		return "", mapError(err)
	}
	if err = fileio.SyncRoot(parent); err != nil {
		return "", fail("durability_uncertain")
	}
	if err = fileio.Sync(dir); err != nil {
		return "", fail("durability_uncertain")
	}
	record.State = "restored"
	if err = s.trash.Write(record); err != nil {
		return "", fail("durability_uncertain")
	}
	_ = s.trash.Remove(id)
	return record.Path, nil
}
