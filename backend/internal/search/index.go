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
	"sort"
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
	paths      []string
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
	requests             chan struct{}
	pendingFull          bool
	pendingRebuild       bool
	pendingPaths         map[string]struct{}
	cancel               context.CancelFunc
	done                 chan struct{}
}

const DefaultBodyLimit int64 = 5 << 20

var ErrUnavailable = errors.New("搜索索引暂时不可用，文件编辑不受影响；可尝试重建索引")

func Open(directory string, store *storage.Store, bodyLimit int64) (*Index, error) {
	if bodyLimit < 1 || bodyLimit > 100<<20 {
		return nil, errors.New("索引正文限制必须介于 1 字节和 100 MiB")
	}
	index := &Index{store: store, filename: filepath.Join(directory, "search.db"), bodyLimit: bodyLimit, requests: make(chan struct{}, 1), pendingPaths: make(map[string]struct{}), done: make(chan struct{})}
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

// Refresh 仅供启动核对、手动重建与不确定结果补偿；不设置周期扫描。
func (i *Index) Refresh(full bool) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.requested++
	i.pendingFull = true
	i.pendingRebuild = i.pendingRebuild || full
	clear(i.pendingPaths)
	i.wake()
}

// Changed 在文件 API 操作后调用；合并同路径及已覆盖的子树，读取时以磁盘最新内容为准。
func (i *Index) Changed(paths ...string) {
	i.mu.Lock()
	defer i.mu.Unlock()
	added := false
	for _, name := range paths {
		if storage.ValidPath(name, false) != nil {
			continue
		}
		added = true
		if i.pendingFull {
			continue
		}
		covered := false
		for previous := range i.pendingPaths {
			if name == previous || strings.HasPrefix(name, previous+"/") {
				covered = true
				break
			}
			if strings.HasPrefix(previous, name+"/") {
				delete(i.pendingPaths, previous)
			}
		}
		if !covered {
			i.pendingPaths[name] = struct{}{}
		}
	}
	if !added {
		return
	}
	i.requested++
	// 限制突发批量操作的队列内存；溢出仅安排一次全量核对，不开启轮询。
	if len(i.pendingPaths) > 256 {
		i.pendingFull = true
		clear(i.pendingPaths)
	}
	i.wake()
}
func (i *Index) wake() {
	select {
	case i.requests <- struct{}{}:
	default:
	}
}
func (i *Index) take() (scanRequest, bool) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.requested <= i.completed {
		return scanRequest{}, false
	}
	request := scanRequest{full: i.pendingRebuild, generation: i.requested}
	if !i.pendingFull {
		request.paths = make([]string, 0, len(i.pendingPaths))
		for name := range i.pendingPaths {
			request.paths = append(request.paths, name)
		}
		sort.Strings(request.paths)
	}
	i.pendingFull = false
	i.pendingRebuild = false
	clear(i.pendingPaths)
	return request, true
}
func (i *Index) run(ctx context.Context) {
	defer close(i.done)
	for {
		select {
		case <-ctx.Done():
			return
		case <-i.requests:
			// 单次合并窗口，不会在工作区闲置时唤醒。
			timer := time.NewTimer(50 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			request, ok := i.take()
			if !ok {
				continue
			}
			i.scan(ctx, request.full, request.paths)
			i.mu.Lock()
			i.completed = max(i.completed, request.generation)
			i.mu.Unlock()
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
func (i *Index) scan(ctx context.Context, full bool, paths []string) {
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
	// 文件在核对期间再次保存属于正常竞争，有限次重读最新磁盘内容，不开启后台轮询。
	var count int
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		count, err = i.update(ctx, full, paths)
		if err == nil {
			break
		}
		var problem *storage.Error
		if ctx.Err() != nil || !errors.As(err, &problem) || (problem.Code != "file_changed" && problem.Code != "not_found") {
			break
		}
	}
	if err != nil {
		i.failed(err)
		return
	}
	i.mu.Lock()
	i.status.Files = count
	i.status.IndexedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if paths == nil {
		i.status.Warning = ""
	}
	i.mu.Unlock()
}

func (i *Index) update(ctx context.Context, full bool, paths []string) (int, error) {
	i.dbMu.RLock()
	defer i.dbMu.RUnlock()
	if i.db == nil {
		return 0, ErrUnavailable
	}
	tx, err := i.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	known := map[string]string{}
	if full {
		_, err = tx.ExecContext(ctx, "DELETE FROM documents")
	} else {
		var rows *sql.Rows
		query := "SELECT path,stamp FROM documents"
		args := []any{}
		if paths != nil {
			conditions := make([]string, 0, len(paths))
			for _, name := range paths {
				conditions = append(conditions, "(path=? OR substr(path,1,?)=?)")
				args = append(args, name, len([]rune(name))+1, name+"/")
			}
			query += " WHERE " + strings.Join(conditions, " OR ")
		}
		rows, err = tx.QueryContext(ctx, query, args...)
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
		return 0, err
	}
	visit := func(entry storage.IndexEntry) error {
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
	}
	if paths == nil {
		err = i.store.Scan(ctx, visit)
	} else {
		for _, name := range paths {
			if err = i.store.ScanPath(ctx, name, visit); err != nil {
				break
			}
		}
	}
	if err == nil {
		for name := range known {
			if _, err = tx.ExecContext(ctx, "DELETE FROM documents WHERE path=?", name); err != nil {
				break
			}
		}
	}
	count := 0
	if err == nil {
		err = tx.QueryRowContext(ctx, "SELECT count(*) FROM documents").Scan(&count)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		return 0, err
	}
	return count, nil
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
