package storage

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestUnifiedPatchFormatsAndPreservation(t *testing.T) {
	cases := []struct {
		name, source, diff, want string
		added, deleted           int
	}{
		{"替换和上下文", "a\nb\nc\n", "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n", "a\nB\nc\n", 1, 1},
		{"混合换行与 BOM", "\ufeffa\r\nb\nc\r", "@@ -2 +2 @@\n-b\n+B\n", "\ufeffa\r\nB\nc\r", 1, 1},
		{"CRLF 替换继承位置", "a\r\nb\nc\r", "@@ -1 +1 @@\n-a\n+A\n", "A\r\nb\nc\r", 1, 1},
		{"新增使用首个换行", "a\r\nb\n", "@@ -1,0 +2 @@\n+new\n", "a\r\nnew\r\nb\n", 1, 0},
		{"空文件新增", "", "@@ -0,0 +1,2 @@\n+a\n+b\n", "a\nb\n", 2, 0},
		{"删除整个文件内容", "a\n", "@@ -1 +0,0 @@\n-a\n", "", 0, 1},
		{"末尾无换行替换", "a", "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n", "b", 1, 1},
		{"显式添加末尾换行", "a", "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n", "a\n", 1, 1},
		{"显式去掉末尾换行", "a\n", "@@ -1 +1 @@\n-a\n+a\n\\ No newline at end of file\n", "a", 1, 1},
		{"多个块新旧坐标", "a\nb\nc\nd\n", "@@ -1 +1,2 @@\n-a\n+A\n+extra\n@@ -4 +5 @@\n-d\n+D\n", "A\nextra\nb\nc\nD\n", 3, 2},
		{"可选文件头和 CRLF framing", "a\r\n", "--- a/note.txt\told\r\n+++ b/note.txt\tnew\r\n@@ -1 +1 @@ section\r\n-a\r\n+b\r\n", "b\r\n", 1, 1},
		{"BOM 文件清空保留 BOM", "\ufeffa\n", "@@ -1 +0,0 @@\n-a\n", "\ufeff", 0, 1},
		{"纯上下文", "a\nb\n", "@@ -1,2 +1,2 @@\n a\n b\n", "a\nb\n", 0, 0},
		{"相同内容不改换行", "a\r\n", "@@ -1 +1 @@\n-a\n+a\n", "a\r\n", 1, 1},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			actual, added, deleted, err := applyUnifiedPatch("note.txt", tt.source, tt.diff, 1<<20)
			if err != nil || actual != tt.want || added != tt.added || deleted != tt.deleted {
				t.Fatalf("got %q +%d -%d %v; want %q", actual, added, deleted, err, tt.want)
			}
		})
	}
}
func TestUnifiedPatchRejectsMismatchAndUnsafeSyntax(t *testing.T) {
	cases := []struct{ diff, code string }{
		{"", "invalid_patch"},
		{"@@ -1,2 +1 @@\n-a\n+b\n", "invalid_patch"},
		{"@@ -1 +1 @@\n-wrong\n+b\n", "patch_mismatch"},
		{"@@ -4 +4 @@\n-a\n+b\n", "patch_mismatch"},
		{"@@ -1 +2 @@\n-a\n+b\n", "invalid_patch"},
		{"@@ -0 +1 @@\n-a\n+b\n", "invalid_patch"},
		{"@@ -1 +1 @@\n-a\n+b\n@@ -1 +1 @@\n-a\n+c\n", "invalid_patch"},
		{"@@ -1 +1 @@\n-a\n+b\n--- other\n+++ other\n", "invalid_patch"},
		{"--- a/other.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-a\n+b\n", "invalid_patch"},
		{"--- /dev/null\n+++ note.txt\n@@ -0,0 +1 @@\n+b\n", "invalid_patch"},
		{"diff --git a/note.txt b/note.txt\n@@ -1 +1 @@\n-a\n+b\n", "invalid_patch"},
		{"@@ -9999999999999999999999999999 +1 @@\n-a\n+b\n", "invalid_patch"},
		{"@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n", "patch_mismatch"},
		{"@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n", "invalid_patch"},
		{"@@ -1 +1 @@\n-a\n+b\x00\n", "invalid_patch"},
	}
	for _, tt := range cases {
		_, _, _, err := applyUnifiedPatch("note.txt", "a\nb\n", tt.diff, 100)
		code(t, err, tt.code)
	}
	_, _, _, err := applyUnifiedPatch("note.txt", "a", "@@ -1 +1 @@\n-a\n+b\n", 100)
	code(t, err, "patch_mismatch")
	_, _, _, err = applyUnifiedPatch("note.txt", "a\n", "@@ -1 +1 @@\n-a\n+too long\n", 3)
	code(t, err, "too_large")
	_, _, _, err = applyUnifiedPatch("note.txt", "a\n", strings.Repeat("x", PatchByteLimit+1), 100)
	code(t, err, "patch_too_large")
	_, _, _, err = applyUnifiedPatch("note.txt", strings.Repeat("\n", PatchSourceLineLimit+1), "@@ -1 +1 @@\n-\n+a\n", 1<<20)
	code(t, err, "patch_too_large")
	var huge strings.Builder
	huge.WriteString(fmt.Sprintf("@@ -0,0 +1,%d @@\n", PatchLineLimit+1))
	huge.WriteString(strings.Repeat("+a\n", PatchLineLimit+1))
	_, _, _, err = applyUnifiedPatch("note.txt", "", huge.String(), 1<<20)
	code(t, err, "patch_too_large")
	huge.Reset()
	for i := 0; i < PatchHunkLimit+1; i++ {
		fmt.Fprintf(&huge, "@@ -%d +%d @@\n-a\n+b\n", i+1, i+1)
	}
	_, _, _, err = applyUnifiedPatch("note.txt", strings.Repeat("a\n", PatchHunkLimit+1), huge.String(), 1<<20)
	code(t, err, "patch_too_large")
}
func TestPatchDryRunQuotaAtomicityAndConcurrency(t *testing.T) {
	store, _ := testStore(t)
	original := "a\r\nb\n"
	revision, err := store.Write("note.txt", original, "", true)
	if err != nil {
		t.Fatal(err)
	}
	diff := "@@ -2 +2 @@\n-b\n+longer\n"
	preview, err := store.Patch("note.txt", diff, revision, true)
	if err != nil || !preview.DryRun || preview.Revision != revision || !preview.Changed || preview.Size != 10 {
		t.Fatal(preview, err)
	}
	current, _ := store.Read("note.txt")
	if current.Content != original {
		t.Fatal("dryRun 写入了正文")
	}
	_, err = store.Patch("note.txt", diff, "", false)
	code(t, err, "precondition_required")
	store.SetQuota(func() (int64, error) { return int64(len(original)), nil })
	_, err = store.Patch("note.txt", diff, revision, false)
	code(t, err, "quota_exceeded")
	current, _ = store.Read("note.txt")
	if current.Content != original {
		t.Fatal("配额失败写入正文")
	}
	bad := "@@ -1 +1 @@\n-a\n+A\n@@ -2 +2 @@\n-wrong\n+B\n"
	_, err = store.Patch("note.txt", bad, revision, false)
	code(t, err, "patch_mismatch")
	current, _ = store.Read("note.txt")
	if current.Content != original {
		t.Fatal("部分提交 hunk")
	}
	store.SetQuota(func() (int64, error) { return 100, nil })
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, replacement := range []string{"A", "B"} {
		wg.Add(1)
		go func(value string) {
			defer wg.Done()
			_, err := store.Patch("note.txt", "@@ -1 +1 @@\n-a\n+"+value+"\n", revision, false)
			results <- err
		}(replacement)
	}
	wg.Wait()
	close(results)
	success, conflicts := 0, 0
	for err := range results {
		if err == nil {
			success++
			continue
		}
		var problem *Error
		if errors.As(err, &problem) && problem.Code == "revision_conflict" {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflicts != 1 {
		t.Fatal("同版本并发补丁未互斥", success, conflicts)
	}
	_, err = store.Patch("../outside", diff, revision, false)
	code(t, err, "path_invalid")
}

// 用标准 diff 生成不同边界的补丁，独立核对解析和应用结果。
func TestUnifiedPatchesGeneratedByGNUDiff(t *testing.T) {
	executable, err := exec.LookPath("diff")
	if err != nil {
		t.Skip("未安装 diff", err)
	}
	dir := t.TempDir()
	oldPath := filepath.Join(dir, "old")
	newPath := filepath.Join(dir, "new")
	values := []string{"", "a\n", "a", "a\nb\nc\n", "first\nrepeat\nrepeat\nlast", "新行\nemoji 📝\n", "\n\nend\n"}
	for _, before := range values {
		for _, after := range values {
			if before == after {
				continue
			}
			if err = os.WriteFile(oldPath, []byte(before), 0600); err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(newPath, []byte(after), 0600); err != nil {
				t.Fatal(err)
			}
			raw, err := exec.Command(executable, "-u", "--label=a/note.txt", "--label=b/note.txt", oldPath, newPath).Output()
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 1 {
				t.Fatalf("diff 生成失败：%v", err)
			}
			actual, _, _, err := applyUnifiedPatch("note.txt", before, string(raw), 1<<20)
			if err != nil || actual != after {
				t.Fatalf("标准 diff 应用不符 %q -> %q: got %q %v\n%s", before, after, actual, err, raw)
			}
		}
	}
}
func FuzzUnifiedPatchNoPanic(f *testing.F) {
	f.Add("a\n", "@@ -1 +1 @@\n-a\n+b\n")
	f.Add("", "@@ -0,0 +1 @@\n+a\n")
	f.Fuzz(func(t *testing.T, source, diff string) {
		if len(source) > 4096 || len(diff) > 4096 {
			return
		}
		_, _, _, _ = applyUnifiedPatch("note.txt", source, diff, 8192)
	})
}

func TestPatchNoopPreservesFile(t *testing.T) {
	store, root := testStore(t)
	revision, err := store.Write("note.txt", "a\r\nb\n", "", true)
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(filepath.Join(root, "note.txt"))
	if err != nil {
		t.Fatal(err)
	}
	for _, dryRun := range []bool{true, false} {
		for _, diff := range []string{"@@ -1 +1 @@\n-a\n+a\n", "@@ -1,2 +1,2 @@\n a\n b\n"} {
			result, err := store.Patch("note.txt", diff, revision, dryRun)
			if err != nil || result.Changed || result.Revision != revision || result.AddedLines != 0 || result.DeletedLines != 0 {
				t.Fatalf("%+v %v", result, err)
			}
		}
	}
	after, err := os.Stat(filepath.Join(root, "note.txt"))
	if err != nil || !os.SameFile(before, after) || !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("无变化补丁重新落盘", err)
	}
	_, err = store.Patch("note.txt", "@@ -1 +1 @@\n wrong\n", revision, false)
	code(t, err, "patch_mismatch")
}
