package storage

// TransferProgress 以用户、阶段和文件数量报告迁移进度，不包含凭据或正文。
type TransferProgress struct {
	UserID      int64
	Stage       string
	Done, Total int
}
type ProgressFunc func(TransferProgress)

func reportTransfer(report ProgressFunc, id int64, stage string, done, total int) {
	if report != nil {
		report(TransferProgress{id, stage, done, total})
	}
}
