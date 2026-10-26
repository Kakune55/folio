package storage

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"folio/internal/trash"
)

func withTrash(t *testing.T, store *Store, directory string) *trash.Repository {
	t.Helper()
	repository, err := trash.Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { repository.Close() })
	store.SetTrash(repository)
	return repository
}
func TestMovePreservesContentsAndRejectsCollision(t *testing.T) {
	store, root := testStore(t)
	if err := store.Mkdir("目录"); err != nil {
		t.Fatal(err)
	}
	revision, err := store.Write("目录/甲.md", "中文内容\n", "", true)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Move("目录/甲.md", "目录/乙.md", revision); err != nil {
		t.Fatal(err)
	}
	content, err := store.Read("目录/乙.md")
	if err != nil || content.Content != "中文内容\n" {
		t.Fatalf("移动丢内容：%v", err)
	}
	_, err = store.Write("目录/已有.md", "另一份", "", true)
	if err != nil {
		t.Fatal(err)
	}
	code(t, store.Move("目录/乙.md", "目录/已有.md", content.Revision), "target_exists")
	if err = os.WriteFile(filepath.Join(root, "目录/乙.md"), []byte("外部更新"), 0o644); err != nil {
		t.Fatal(err)
	}
	code(t, store.Move("目录/乙.md", "目录/丙.md", content.Revision), "revision_conflict")
	directory, err := store.EntryRevision("目录")
	if err != nil {
		t.Fatal(err)
	}
	code(t, store.Move("目录", "目录/子目录", directory.Revision), "path_invalid")
	if err = store.Move("目录", "新目录", directory.Revision); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(root, "新目录/乙.md")); err != nil || string(data) != "外部更新" {
		t.Fatal("目录移动失败")
	}
}
func TestTrashRestoreAndCollision(t *testing.T) {
	store, root := testStore(t)
	trashRoot := t.TempDir()
	repository := withTrash(t, store, trashRoot)
	_, missingErr := store.Restore("deadbeefdeadbeefdeadbeefdeadbeef")
	code(t, missingErr, "trash_not_found")
	revision, err := store.Write("笔记.md", "保留原文", "", true)
	if err != nil {
		t.Fatal(err)
	}
	record, err := store.Trash("笔记.md", revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(root, "笔记.md")); !os.IsNotExist(err) {
		t.Fatal("原件仍存在")
	}
	entries, total, err := store.TrashList(0, 200)
	if err != nil || total != 1 || entries[0].State != "ready" {
		t.Fatalf("恢复记录不正确：%+v %v", entries, err)
	}
	if _, err = store.Write("笔记.md", "后来创建", "", true); err != nil {
		t.Fatal(err)
	}
	_, err = store.Restore(record.ID)
	code(t, err, "target_exists")
	if err = os.Remove(filepath.Join(root, "笔记.md")); err != nil {
		t.Fatal(err)
	}
	if _, err = store.Restore(record.ID); err != nil {
		t.Fatal(err)
	}
	_, err = store.Restore(record.ID)
	code(t, err, "trash_not_found")
	if data, err := os.ReadFile(filepath.Join(root, "笔记.md")); err != nil || string(data) != "保留原文" {
		t.Fatal("恢复内容不正确")
	}
	_, total, err = repository.List(0, 200)
	if err != nil || total != 0 {
		t.Fatal("恢复后仍显示待恢复条目")
	}
	_, err = store.Restore("../../escape")
	code(t, err, "path_invalid")
	// 整条记录消失与已有目录内缺失清单必须区分，避免把真正损坏当成 404。
	id := "deadbeefdeadbeefdeadbeefdeadbeef"
	if err := os.Mkdir(filepath.Join(trashRoot, id), 0o700); err != nil {
		t.Fatal(err)
	}
	_, err = store.Restore(id)
	code(t, err, "trash_damaged")
	retained, err := repository.Create("笔记.md", "file", revision)
	if err != nil {
		t.Fatal(err)
	}
	retained.State = "restored"
	if err := repository.Write(retained); err != nil {
		t.Fatal(err)
	}
	_, err = store.Restore(retained.ID)
	code(t, err, "already_restored")
}
func TestIncompleteTrashCanRestoreStagedOriginal(t *testing.T) {
	store, root := testStore(t)
	repository := withTrash(t, store, t.TempDir())
	revision, err := store.Write("故障.md", "故障前的完整原文", "", true)
	if err != nil {
		t.Fatal(err)
	}
	record, err := repository.Create("故障.md", "file", revision)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(filepath.Join(root, "故障.md"), filepath.Join(root, record.Stage)); err != nil {
		t.Fatal(err)
	}
	if _, err = store.Restore(record.ID); err != nil {
		t.Fatal(err)
	}
	content, err := store.Read("故障.md")
	if err != nil || content.Content != "故障前的完整原文" {
		t.Fatal("隔离原件未恢复")
	}
}
func TestTrashRejectsUnsafeSubtreeAndActiveUpload(t *testing.T) {
	store, root := testStore(t)
	withTrash(t, store, t.TempDir())
	if err := store.Mkdir("目录"); err != nil {
		t.Fatal(err)
	}
	t.Run("链接子树", func(t *testing.T) {
		if err := os.Symlink("/etc/passwd", filepath.Join(root, "目录/外链")); err != nil {
			if runtime.GOOS == "windows" {
				t.Skipf("当前 Windows 无符号链接权限：%v", err)
			}
			t.Fatal(err)
		}
		_, err := store.EntryRevision("目录")
		code(t, err, "unsupported_file_type")
	})
	revision, err := store.Write("图片.md", "正文", "", true)
	if err != nil {
		t.Fatal(err)
	}
	store.uploads["图片.md"] = 1
	_, err = store.Trash("图片.md", revision)
	code(t, err, "operation_in_progress")
	if _, err = os.Stat(filepath.Join(root, "图片.md")); errors.Is(err, os.ErrNotExist) {
		t.Fatal("上传中误删原文")
	}
}

func TestPartialStagedDirectoryDoesNotReplaceCompleteRecovery(t *testing.T) {
	store, root := testStore(t)
	repository := withTrash(t, store, t.TempDir())
	if err := store.Mkdir("目录"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Write("目录/甲.md", "甲的内容", "", true); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Write("目录/乙.md", "乙的内容", "", true); err != nil {
		t.Fatal(err)
	}
	revision, err := store.EntryRevision("目录")
	if err != nil {
		t.Fatal(err)
	}
	record, err := repository.Create("目录", "directory", revision.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(filepath.Join(root, "目录"), filepath.Join(root, record.Stage)); err != nil {
		t.Fatal(err)
	}
	data, err := repository.Directory(record.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	if _, _, err = copyEntry(store.fileOpener, record.Stage, data, "payload"); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(filepath.Join(root, record.Stage, "乙.md")); err != nil {
		t.Fatal(err)
	}
	_, err = store.Restore(record.ID)
	code(t, err, "trash_incomplete")
	original, err := data.ReadFile("payload/乙.md")
	if err != nil || string(original) != "乙的内容" {
		t.Fatal("完整恢复副本被清理")
	}
	if _, err = os.Stat(filepath.Join(root, "目录")); !os.IsNotExist(err) {
		t.Fatal("残缺的隔离原件被伪装为完整恢复")
	}
}
