package auth

import (
	"errors"
	"fmt"

	"golang.org/x/crypto/argon2"
)

// ResetPassword 仅供持有 app-data 权限的离线运维使用，不提供 HTTP 入口。
func ResetPassword(directory, passwordFile string) (err error) {
	password, err := ReadPasswordFile(passwordFile)
	if err != nil {
		return err
	}
	service, err := open(directory, "", true)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if closeErr := service.Close(); closeErr != nil {
			if committed {
				err = fmt.Errorf("重置已提交，但关闭账号库失败；先核验新密码，不要删除账号库：%w", closeErr)
			} else {
				err = errors.Join(err, closeErr)
			}
		}
	}()
	var integrity string
	if err = service.db.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		return errors.New("账号库完整性检查失败，请先从备份恢复，不自动修复")
	}
	var triggers int
	if err = service.db.QueryRow("SELECT count(*) FROM sqlite_schema WHERE type='trigger'").Scan(&triggers); err != nil || triggers != 0 {
		return errors.New("账号库含未知结构或触发器，拒绝重置")
	}
	var accounts int
	if err = service.db.QueryRow("SELECT count(*) FROM account").Scan(&accounts); err != nil || accounts < 1 {
		return errors.New("账号库没有可恢复的管理员，拒绝重置")
	}
	// 初始化盐也用于浏览器草稿命名空间；同一账号改密保持该盐不变。
	hash := argon2.IDKey([]byte(password), service.salt, 3, 64*1024, 1, 32)
	tx, err := service.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.Exec("UPDATE account SET hash=? WHERE id=1", hash)
	if err != nil {
		return err
	}
	rows, err := result.RowsAffected()
	if err != nil || rows != 1 {
		return errors.New("账号不唯一或更新失败，未提交重置")
	}
	if _, err = tx.Exec("DELETE FROM sessions"); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return errors.New("重置提交结果不确定：保持服务停止并用新密码核验，不要删除账号库或盲目重复操作")
	}
	committed = true
	return nil
}
