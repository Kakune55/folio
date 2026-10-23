package storage

import "folio/internal/fileio"

type Usage struct {
	Used  int64 `json:"used"`
	Quota int64 `json:"quota"`
}

func (s *Store) SetQuota(get func() (int64, error)) { s.mu.Lock(); defer s.mu.Unlock(); s.quota = get }
func (s *Store) usageLocked() (Usage, error) {
	q := int64(0)
	var err error
	if s.quota != nil {
		q, err = s.quota()
		if err != nil {
			return Usage{}, err
		}
	}
	used, err := fileio.TreeBytes(s.root, ".", true)
	if err != nil {
		return Usage{}, err
	}
	if s.trash != nil {
		n, e := s.trash.Usage()
		if e != nil {
			return Usage{}, e
		}
		used += n
	}
	if s.extraUsage != nil {
		n, e := s.extraUsage()
		if e != nil {
			return Usage{}, e
		}
		used += n
	}
	return Usage{Used: used, Quota: q}, nil
}
func (s *Store) Usage() (Usage, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.usageLocked() }
func (s *Store) checkQuota(delta int64) error {
	if s.quota == nil || delta <= 0 {
		return nil
	}
	usage, err := s.usageLocked()
	if err != nil {
		return err
	}
	if delta > usage.Quota-usage.Used {
		return fail("quota_exceeded")
	}
	return nil
}
func (s *Store) Purge(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.trash == nil {
		return fail("trash_unavailable")
	}
	record, err := s.trash.Read(id)
	if err != nil || record.State != "ready" {
		return fail("trash_damaged")
	}
	// 未完成记录可能还有工作区中的隔离原件，只允许清理可恢复的完整记录。
	return s.trash.Remove(id)
}
