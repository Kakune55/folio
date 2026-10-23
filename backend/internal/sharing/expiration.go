package sharing

import (
	"errors"
	"fmt"
	"log"
	"time"
)

func (s *Service) expirationLoop() {
	defer close(s.stopped)
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.stop:
			return
		case now := <-ticker.C:
			if err := s.cleanExpired(now.Unix()); err != nil {
				log.Printf("清理到期分享失败，将自动重试：%v", err)
			}
		}
	}
}
func (s *Service) cleanExpired(now int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cleanExpiredLocked(now, 0)
}
func (s *Service) cleanExpiredLocked(now, owner int64) error {
	// 每轮有界；列表只清理当前用户，启动与后台按全站到期顺序清理。
	rows, err := s.db.Query(`SELECT id FROM shares WHERE (?=0 OR owner=?) AND json_extract(record,'$.expiresAt')>0 AND json_extract(record,'$.expiresAt')<=? ORDER BY json_extract(record,'$.expiresAt') LIMIT 1000`, owner, owner, now)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = errors.Join(rows.Err(), rows.Close())
	if err != nil {
		return err
	}
	var failures []error
	for _, id := range ids {
		record, e := s.load(id)
		if e == nil {
			e = s.deleteRecord(record)
		}
		if e != nil {
			failures = append(failures, fmt.Errorf("分享 %s：%w", id, e))
		}
	}
	return errors.Join(failures...)
}
