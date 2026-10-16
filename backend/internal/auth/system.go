package auth

import "database/sql"

// 系统设置与账号元数据同库持久化，不保存正文。
func (s *Service) SystemSettings() ([]byte, error) {
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS system_settings (id INTEGER PRIMARY KEY CHECK(id=1), value BLOB NOT NULL)`); err != nil {
		return nil, err
	}
	var value []byte
	err := s.db.QueryRow(`SELECT value FROM system_settings WHERE id=1`).Scan(&value)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return value, err
}
func (s *Service) SaveSystemSettings(value []byte) error {
	_, err := s.db.Exec(`INSERT INTO system_settings(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`, value)
	return err
}
