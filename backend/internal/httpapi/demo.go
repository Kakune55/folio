package httpapi

import (
	_ "embed"
	"errors"
	"fmt"
	"log"

	"folio/internal/auth"
	"folio/internal/fileio"
	"folio/internal/storage"
)

//go:embed demo-introduction.md
var demoIntroduction string

const demoIntroductionName = "欢迎体验 Folio.md"

func (a *Accounts) seedDemoWorkspace(user auth.User) error {
	if user.ID <= 0 || user.Admin || !user.Enabled || user.Username != auth.DemoUsername || user.Quota != auth.DemoQuota {
		return errors.New("演示账号状态不正确，拒绝初始化工作区")
	}
	entry, err := a.get(user.ID)
	if err != nil {
		return fmt.Errorf("初始化演示工作区失败：%w", err)
	}
	_, err = entry.store.Write(demoIntroductionName, demoIntroduction, "", true)
	if err != nil {
		var problem *storage.Error
		if !errors.As(err, &problem) || problem.Code != "target_exists" {
			return fmt.Errorf("创建演示介绍失败，已有内容未被覆盖：%w", err)
		}
		file, _, openErr := entry.store.OpenDownload(demoIntroductionName, false)
		if openErr != nil { return fmt.Errorf("同名演示介绍不可安全打开，已有条目未被覆盖：%w", openErr) }
		linkErr := fileio.CheckSingleLink(file)
		closeErr := file.Close()
		if err = errors.Join(linkErr, closeErr); err != nil { return fmt.Errorf("同名演示介绍链接检查失败，已有条目未被覆盖：%w", err) }
		if _, err = entry.store.Read(demoIntroductionName); err != nil {
			return fmt.Errorf("同名演示介绍不可安全读取，已有条目未被覆盖：%w", err)
		}
		log.Print("演示介绍文件已存在，保留其原始内容。")
	}
	entry.index.Changed(demoIntroductionName)
	if err = a.auth.MarkDemoSeeded(user.ID); err != nil {
		return fmt.Errorf("记录演示初始化状态失败，已创建的文件保留：%w", err)
	}
	return nil
}
