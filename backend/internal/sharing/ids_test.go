package sharing

import (
	"strings"
	"testing"
)

func TestShortShareIDsAndLegacyCompatibility(t *testing.T) {
	s, stores, _ := fixture(t)
	write(t, stores[1], "id.txt", "原始内容")
	r, err := s.Save(1, "", input(t, stores[1], "id.txt", "snapshot", false))
	if err != nil {
		t.Fatal(err)
	}
	if len(r.ID) != 16 || !validShareID(r.ID) {
		t.Fatal("短链接格式错误", r.ID)
	}
	if len(r.Version) != 48 || len(r.Files[0].ID) != 48 {
		t.Fatal("缩短了内部令牌")
	}
	// 旧链接保持既有格式和原快照位置。
	oldID := r.ID
	r.ID = random()
	if err = s.save(r); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec("DELETE FROM shares WHERE id=?", oldID); err != nil {
		t.Fatal(err)
	}
	_, token, err := s.Enter(r.ID, "", "", "legacy")
	if err != nil {
		t.Fatal(err)
	}
	file, _, err := s.File(r.ID, token, r.Files[0].ID)
	if err != nil || string(file.Data) != "原始内容" {
		t.Fatal(err)
	}
	for _, id := range []string{strings.Repeat("a", 15), strings.Repeat("a", 17), "abcdefghijklmn+/", "abcdefghijklmn==", strings.Repeat("g", 48), "../abcdefghijklmn"} {
		if validShareID(id) {
			t.Fatal("接受非法 ID", id)
		}
	}
	if !validShareID("_-Ab0123456789xy") {
		t.Fatal("未接受 URL 安全字符")
	}
}

func TestShareIDCollisionDoesNotOverwrite(t *testing.T) {
	s, stores, _ := fixture(t)
	write(t, stores[1], "one.txt", "existing")
	existing, err := s.Save(1, "", input(t, stores[1], "one.txt", "snapshot", false))
	if err != nil {
		t.Fatal(err)
	}
	next := *existing
	next.Title = "新分享"
	calls := 0
	if err = s.insertNew(&next, func() string { calls++; return "_-Ab0123456789xy" }); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || next.ID == existing.ID {
		t.Fatal("冲突没有重试")
	}
	original, err := s.load(existing.ID)
	if err != nil || original.Title != existing.Title || original.Version != existing.Version {
		t.Fatal("冲突覆盖原分享", err)
	}
	// 持续冲突有界退出，不死循环、不更新原记录。
	next.ID = existing.ID
	if err = s.insertNew(&next, func() string { return existing.ID }); err == nil {
		t.Fatal("持续冲突未报告失败")
	}
}
