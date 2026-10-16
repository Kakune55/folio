package search

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"folio/internal/fileio"
	"log"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"folio/internal/storage"
	_ "modernc.org/sqlite"
)

type Status struct {
	Indexing  bool   `json:"indexing"`
	IndexedAt string `json:"indexedAt"`
	Files     int    `json:"files"`
	Warning   string `json:"warning,omitempty"`
}
type Result struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Excerpt string `json:"excerpt"`
}
type Response struct {
	Entries   []Result `json:"entries"`
	Truncated bool     `json:"truncated"`
	Limit     int      `json:"limit"`
	Status    Status   `json:"status"`
}
type scanRequest struct {
	full       bool
	generation uint64
}
type Index struct {
	requested, completed uint64
	store                *storage.Store
	filename             string
	bodyLimit            int64
	dbMu                 sync.RWMutex
	db                   *sql.DB
	mu                   sync.Mutex
	status               Status
	requests             chan scanRequest
	cancel               context.CancelFunc
	done                 chan struct{}
}

const DefaultBodyLimit int64 = 1 << 20

var ErrUnavailable = errors.New("搜索索引暂时不可用，文件编辑不受影响；可尝试重建索引")

func Open(directory string, store *storage.Store, bodyLimit int64) (*Index, error) {
	if bodyLimit < 1 || bodyLimit > 100<<20 {
		return nil, errors.New("索引正文限制必须介于 1 字节和 100 MiB")
	}
	index := &Index{store: store, filename: filepath.Join(directory, "search.db"), bodyLimit: bodyLimit, requests: make(chan scanRequest, 1), done: make(chan struct{})}
	db, err := openDB(index.filename)
	index.db = db
	if err != nil {
		index.status.Warning = ErrUnavailable.Error()
		log.Printf("搜索缓存初始化失败：%v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	index.cancel = cancel
	go index.run(ctx)
	index.Refresh(err == nil)
	return index, nil
}
func openDB(filename string) (*sql.DB, error) {
	file, err := os.OpenFile(filename, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	file.Close()
	if err = os.Chmod(filename, 0o600); err != nil {
		return nil, err
	}
	uri := fileio.FileURL(filename) + "?_pragma=busy_timeout(1000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", uri)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(2)
	if _, err = db.Exec(`CREATE VIRTUAL TABLE IF NOT EXISTS documents USING fts5(path,body,stamp UNINDEXED,tokenize='trigram');`); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}
func (i *Index) Close() error {
	i.cancel()
	<-i.done
	i.dbMu.Lock()
	defer i.dbMu.Unlock()
	if i.db != nil {
		return i.db.Close()
	}
	return nil
}
func (i *Index) Status() Status {
	i.mu.Lock()
	defer i.mu.Unlock()
	status := i.status
	status.Indexing = status.Indexing || i.requested > i.completed
	return status
}
func (i *Index) Refresh(full bool) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.requested++
	// 合并尚未消费的请求，同时保留 full 级别与最后请求序号。
	select {
	case previous := <-i.requests:
		full = full || previous.full
	default:
	}
	i.requests <- scanRequest{full: full, generation: i.requested}
}
func (i *Index) run(ctx context.Context) {
	defer close(i.done)
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	lastFull := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case request := <-i.requests:
			i.scan(ctx, request.full)
			i.mu.Lock()
			i.completed = max(i.completed, request.generation)
			i.mu.Unlock()
			if request.full {
				lastFull = time.Now()
			}
		case <-ticker.C:
			full := time.Since(lastFull) >= 5*time.Minute && i.Status().Warning == ""
			i.scan(ctx, full)
			if full {
				lastFull = time.Now()
			}
		}
	}
}
func (i *Index) recoverCache() error {
	i.dbMu.Lock()
	defer i.dbMu.Unlock()
	if i.db != nil {
		i.db.Close()
		i.db = nil
	}
	backup, err := os.MkdirTemp(filepath.Dir(i.filename), "search-recovery-")
	if err != nil {
		return err
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		source := i.filename + suffix
		if err = os.Rename(source, filepath.Join(backup, filepath.Base(source))); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	i.db, err = openDB(i.filename)
	return err
}
func (i *Index) scan(ctx context.Context, full bool) {
	previous := i.Status()
	i.mu.Lock()
	i.status.Indexing = true
	i.mu.Unlock()
	defer func() { i.mu.Lock(); i.status.Indexing = false; i.mu.Unlock() }()
	if full && previous.Warning != "" {
		if err := i.recoverCache(); err != nil {
			i.failed(err)
			return
		}
	}
	i.dbMu.RLock()
	defer i.dbMu.RUnlock()
	if i.db == nil {
		i.failed(ErrUnavailable)
		return
	}
	tx, err := i.db.BeginTx(ctx, nil)
	if err != nil {
		i.failed(err)
		return
	}
	defer tx.Rollback()
	known := map[string]string{}
	if full {
		_, err = tx.ExecContext(ctx, "DELETE FROM documents")
	} else {
		var rows *sql.Rows
		rows, err = tx.QueryContext(ctx, "SELECT path,stamp FROM documents")
		if err == nil {
			for rows.Next() {
				var name, stamp string
				if err = rows.Scan(&name, &stamp); err != nil {
					break
				}
				known[name] = stamp
			}
			if err == nil {
				err = rows.Err()
			}
			rows.Close()
		}
	}
	if err != nil {
		i.failed(err)
		return
	}
	count := 0
	err = i.store.Scan(ctx, func(entry storage.IndexEntry) error {
		count++
		previous, exists := known[entry.Path]
		delete(known, entry.Path)
		if exists && previous == entry.Stamp {
			return nil
		}
		body := ""
		if entry.Size <= i.bodyLimit {
			var err error
			body, err = i.store.ReadIndexText(entry.Path, entry.Stamp, i.bodyLimit)
			if err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM documents WHERE path=?", entry.Path); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO documents(path,body,stamp) VALUES(?,?,?)", entry.Path, body, entry.Stamp)
		return err
	})
	if err == nil {
		for name := range known {
			if _, err = tx.ExecContext(ctx, "DELETE FROM documents WHERE path=?", name); err != nil {
				break
			}
		}
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		i.failed(err)
		return
	}
	i.mu.Lock()
	i.status.Files = count
	i.status.IndexedAt = time.Now().UTC().Format(time.RFC3339Nano)
	i.status.Warning = ""
	i.mu.Unlock()
}
func (i *Index) failed(err error) {
	if !errors.Is(err, context.Canceled) {
		log.Printf("搜索索引刷新失败：%v", err)
	}
	i.mu.Lock()
	i.status.Warning = "索引更新失败，结果可能过时；文件编辑不受影响，可重试重建"
	i.mu.Unlock()
}
func (i *Index) Query(ctx context.Context, query, mode string, limit int) (Response, error) {
	output := Response{Entries: []Result{}, Limit: limit, Status: i.Status()}
	if limit < 1 || limit > 200 || utf8.RuneCountInString(query) > 200 || !utf8.ValidString(query) {
		return output, errors.New("查询参数无效")
	}
	if mode != "names" && strings.TrimSpace(query) == "" {
		return output, nil
	}
	i.dbMu.RLock()
	defer i.dbMu.RUnlock()
	if i.db == nil {
		return output, ErrUnavailable
	}
	var rows *sql.Rows
	var err error
	if mode == "names" {
		rows, err = i.db.QueryContext(ctx, `SELECT path,'' FROM documents WHERE instr(lower(path),lower(?))>0 ORDER BY CASE WHEN lower(path)=lower(?) THEN 0 ELSE 1 END,length(path),path LIMIT ?`, query, query, limit+1)
	} else if utf8.RuneCountInString(query) < 3 {
		rows, err = i.db.QueryContext(ctx, `SELECT path,substr(body,max(1,instr(lower(body),lower(?))-50),180) FROM documents WHERE instr(lower(path),lower(?))>0 OR instr(lower(body),lower(?))>0 ORDER BY length(path),path LIMIT ?`, query, query, query, limit+1)
	} else {
		literal := `"` + strings.ReplaceAll(query, `"`, `""`) + `"`
		rows, err = i.db.QueryContext(ctx, `SELECT path,snippet(documents,1,'','','…',30) FROM documents WHERE documents MATCH ? ORDER BY bm25(documents),path LIMIT ?`, literal, limit+1)
	}
	if err != nil {
		return output, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer rows.Close()
	for rows.Next() {
		var result Result
		if err = rows.Scan(&result.Path, &result.Excerpt); err != nil {
			return output, err
		}
		if len(output.Entries) == limit {
			output.Truncated = true
			break
		}
		result.Name = path.Base(result.Path)
		runes := []rune(result.Excerpt)
		if len(runes) > 240 {
			result.Excerpt = string(runes[:240]) + "…"
		}
		output.Entries = append(output.Entries, result)
	}
	if err = rows.Err(); err != nil {
		return output, err
	}
	return output, nil
}
