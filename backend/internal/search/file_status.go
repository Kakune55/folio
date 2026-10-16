package search

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

type FileStatus struct {
	Size      int64  `json:"size"`
	BodyLimit int64  `json:"bodyLimit"`
	State     string `json:"state"`
}

// FileState 对照已提交索引与客户端已保存版本，不读取正文或将草稿作为索引依据。
func (i *Index) FileState(ctx context.Context, name, revision string) (FileStatus, error) {
	output := FileStatus{BodyLimit: i.bodyLimit, State: "not_indexed"}
	size, err := i.store.IndexFileSize(name)
	if err != nil {
		return output, err
	}
	output.Size = size
	if size > i.bodyLimit {
		output.State = "too_large"
		return output, nil
	}
	status := i.Status()
	i.dbMu.RLock()
	defer i.dbMu.RUnlock()
	if i.db == nil {
		return output, ErrUnavailable
	}
	var stamp string
	var hasBody bool
	err = i.db.QueryRowContext(ctx, "SELECT stamp,body!='' FROM documents WHERE path=?", name).Scan(&stamp, &hasBody)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return output, ErrUnavailable
	}
	if status.Warning != "" {
		output.State = "error"
		return output, nil
	}
	missing := errors.Is(err, sql.ErrNoRows)
	outdated := revision != "" && strings.TrimPrefix(revision, "sha256:") != stamp
	if missing || outdated {
		if status.Indexing {
			output.State = "pending"
		}
		return output, nil
	}
	if hasBody || size == 0 {
		output.State = "indexed"
	} else {
		output.State = "names_only"
	}
	return output, nil
}
