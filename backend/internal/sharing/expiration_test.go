package sharing

import (
	"folio/internal/storage"
	"os"
	"testing"
	"time"
)

func TestExpiredSharesRemovePayloadAndGrants(t *testing.T) {
	s, stores, _ := fixture(t)
	write(t, stores[1], "original.txt", "原文件保留")
	in := input(t, stores[1], "original.txt", "snapshot", false)
	r, err := s.Save(1, "", in)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = s.Enter(r.ID, "", "", "expiration")
	if err != nil {
		t.Fatal(err)
	}
	r, _ = s.load(r.ID)
	r.ExpiresAt = time.Now().Add(-time.Second).Unix()
	r.Disabled = true
	if err = s.save(r); err != nil {
		t.Fatal(err)
	}
	if err = s.cleanExpired(time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	_, err = s.load(r.ID)
	status(t, err, 404)
	if _, err = s.root.Stat(r.Payload); !os.IsNotExist(err) {
		t.Fatal("快照未清理", err)
	}
	var grants int
	if err = s.db.QueryRow("SELECT count(*) FROM grants WHERE share_id=?", r.ID).Scan(&grants); err != nil || grants != 0 {
		t.Fatal(grants, err)
	}
	if used, err := s.Usage(1); err != nil || used != 0 {
		t.Fatal("快照配额未释放", used, err)
	}
	if _, err := stores[1].ReadBundle([]storage.BundleFile{{Path: "original.txt"}}); err != nil {
		t.Fatal("原文件被删除", err)
	}
	paused, err := s.Save(1, "", in)
	if err != nil {
		t.Fatal(err)
	}
	paused.Disabled = true
	paused.MaxVisits = 1
	paused.Visits = 1
	if err = s.save(paused); err != nil {
		t.Fatal(err)
	}
	if err = s.cleanExpired(time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	if _, err = s.load(paused.ID); err != nil {
		t.Fatal("暂停或次数用完被误删", err)
	}
}

func TestExpirationListAndRestartCleanup(t *testing.T) {
	s, stores, enabled := fixture(t)
	write(t, stores[1], "root.txt", "内容")
	expire := func() *Record {
		r, err := s.Save(1, "", input(t, stores[1], "root.txt", "snapshot", false))
		if err != nil {
			t.Fatal(err)
		}
		r.ExpiresAt = time.Now().Add(-time.Second).Unix()
		if err = s.save(r); err != nil {
			t.Fatal(err)
		}
		return r
	}
	r := expire()
	entries, total, err := s.List(1, 0, 20)
	if err != nil || total != 0 || len(entries) != 0 {
		t.Fatal(entries, total, err)
	}
	if _, err = s.root.Stat(r.Payload); !os.IsNotExist(err) {
		t.Fatal(err)
	}
	r = expire()
	directory := s.root.Name()
	// Open 接收 app-data 父目录。
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(directory+"/..", func(id int64) (*storage.Store, bool, error) { return stores[id], enabled[id], nil })
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	_, err = reopened.load(r.ID)
	status(t, err, 404)
}

func TestExpirationCleanupFailureRetainsRetryRecord(t *testing.T) {
	s, stores, _ := fixture(t)
	write(t, stores[1], "root.txt", "内容")
	r, err := s.Save(1, "", input(t, stores[1], "root.txt", "snapshot", false))
	if err != nil {
		t.Fatal(err)
	}
	payload := r.Payload
	r.ExpiresAt = time.Now().Add(-time.Second).Unix()
	r.Payload = "missing-owner/snapshot"
	if err = s.save(r); err != nil {
		t.Fatal(err)
	}
	if err = s.cleanExpired(time.Now().Unix()); err == nil {
		t.Fatal("清理失败被隐藏")
	}
	retained, err := s.load(r.ID)
	if err != nil || !retained.Disabled {
		t.Fatal(retained, err)
	}
	retained.Payload = payload
	if err = s.save(retained); err != nil {
		t.Fatal(err)
	}
	if err = s.cleanExpired(time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	_, err = s.load(r.ID)
	status(t, err, 404)
}
