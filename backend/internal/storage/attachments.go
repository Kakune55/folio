package storage

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"path"
	"strings"
	"unicode/utf8"

	"folio/internal/fileio"
	_ "golang.org/x/image/webp"
)

type Limits struct{ Text, Image, PDF, Attachment, ImagePixels int64 }

var DefaultLimits = Limits{Text: 5 << 20, Image: 20 << 20, PDF: 50 << 20, Attachment: 100 << 20, ImagePixels: 32_000_000}

type Metadata struct {
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	MediaType string `json:"mediaType"`
	Viewer    string `json:"viewer"`
	Mtime     string `json:"mtime"`
}

func (s *Store) SetLimits(limits Limits) error {
	if limits.Text < 1 || limits.Image < 1 || limits.PDF < 1 || limits.Attachment < 1 || limits.ImagePixels < 1 || limits.Text > 100<<20 || limits.Attachment > 1<<30 || limits.Image > limits.Attachment || limits.PDF > limits.Attachment {
		return errors.New("文件大小配置不合法")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.limits = limits
	return nil
}
func (s *Store) Limits() Limits { s.mu.Lock(); defer s.mu.Unlock(); return s.limits }
func imageType(data []byte) string {
	media := http.DetectContentType(data)
	switch media {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return media
	}
	return ""
}
func (s *Store) metadata(file *os.File, name string, limits Limits) (*Metadata, error) {
	info, err := regular(file)
	if err != nil {
		return nil, err
	}
	header := make([]byte, 512)
	n, err := file.ReadAt(header, 0)
	if err != nil && err != io.EOF {
		return nil, err
	}
	header = header[:n]
	result := &Metadata{Path: name, Size: info.Size(), MediaType: "application/octet-stream", Viewer: "binary", Mtime: info.ModTime().UTC().Format("2006-01-02T15:04:05.999999999Z07:00")}
	ext := strings.ToLower(path.Ext(name))
	if media := imageType(header); media != "" && ext != ".svg" && ext != ".html" && ext != ".htm" && info.Size() <= limits.Image {
		config, _, decodeErr := image.DecodeConfig(io.NewSectionReader(file, 0, info.Size()))
		if decodeErr == nil && config.Width > 0 && config.Height > 0 && int64(config.Width) <= limits.ImagePixels/int64(config.Height) {
			result.MediaType = media
			result.Viewer = "image"
			return result, nil
		}
	}
	if ext != ".svg" && ext != ".html" && ext != ".htm" && strings.HasPrefix(string(header), "%PDF-") && info.Size() <= limits.PDF {
		result.MediaType = "application/pdf"
		result.Viewer = "pdf"
		return result, nil
	}
	if info.Size() <= limits.Text {
		data, _, readErr := read(file, limits.Text)
		if readErr != nil {
			var problem *Error
			if !errors.As(readErr, &problem) || problem.Code != "unsupported_file_type" {
				return nil, readErr
			}
			if _, err := regular(file); err != nil {
				return nil, err
			}
		}
		if readErr == nil && utf8.Valid(data) && !strings.ContainsRune(string(data), 0) {
			result.Viewer = "text"
			result.MediaType = "text/plain"
			if ext == ".md" || ext == ".markdown" {
				result.Viewer = "markdown"
			}
		}
	}
	return result, nil
}
func (s *Store) Metadata(name string) (*Metadata, error) {
	if err := ValidPath(name, false); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := s.open(name, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return s.metadata(file, name, s.limits)
}

// OpenDownload 返回已验证的描述符；后续传输不再按用户路径重新打开。
func (s *Store) OpenDownload(name string, preview bool) (*os.File, *Metadata, error) {
	if err := ValidPath(name, false); err != nil {
		return nil, nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := s.open(name, os.O_RDONLY, 0)
	if err != nil {
		return nil, nil, err
	}
	metadata, err := s.metadata(file, name, s.limits)
	if err != nil {
		file.Close()
		return nil, nil, err
	}
	if preview && metadata.Viewer != "image" && metadata.Viewer != "pdf" {
		file.Close()
		return nil, nil, fail("preview_unavailable")
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		file.Close()
		return nil, nil, err
	}
	return file, metadata, nil
}
func (s *Store) Upload(directory, name string, reader io.Reader, imageOnly bool) (*Metadata, error) {
	if err := ValidPath(directory, true); err != nil {
		return nil, err
	}
	if strings.Contains(name, "/") || name == "" {
		return nil, fail("path_invalid")
	}
	full := name
	if directory != "" {
		full = directory + "/" + name
	}
	if err := ValidPath(full, false); err != nil {
		return nil, err
	}
	s.mu.Lock()
	remaining := int64(-1)
	if s.quota != nil {
		usage, err := s.usageLocked()
		if err != nil {
			s.mu.Unlock()
			return nil, err
		}
		remaining = max(int64(0), usage.Quota-usage.Used)
	}
	s.uploads[full]++
	limits := s.limits
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.uploads[full]--
		if s.uploads[full] == 0 {
			delete(s.uploads, full)
		}
		s.mu.Unlock()
	}()
	parent, base, err := s.parent(full)
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	buffered := bufio.NewReader(reader)
	header, peekErr := buffered.Peek(512)
	if peekErr != nil && peekErr != io.EOF && peekErr != bufio.ErrBufferFull {
		return nil, peekErr
	}
	limit := limits.Attachment
	ext := strings.ToLower(path.Ext(name))
	if imageType(header) != "" || ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".webp" || ext == ".gif" {
		limit = min(limit, limits.Image)
	}
	if strings.HasPrefix(string(header), "%PDF-") || ext == ".pdf" {
		limit = min(limit, limits.PDF)
	}
	quotaLimited := remaining >= 0 && remaining < limit
	if quotaLimited {
		limit = remaining
	}
	var nonce [16]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	temp := ".folio-tmp-" + hex.EncodeToString(nonce[:])
	file, err := parent.OpenFile(temp, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	defer func() { file.Close(); _ = parent.Remove(temp) }()
	count, err := io.Copy(file, io.LimitReader(buffered, limit+1))
	if err != nil {
		return nil, err
	}
	if count > limit {
		if quotaLimited {
			return nil, fail("quota_exceeded")
		}
		return nil, fail("too_large")
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	metadata, err := s.metadata(file, full, limits)
	if err != nil {
		return nil, err
	}
	if imageOnly && metadata.Viewer != "image" {
		return nil, fail("preview_unavailable")
	}
	if err = file.Chmod(0o644); err != nil {
		return nil, err
	}
	if err = fileio.Sync(file); err != nil {
		return nil, err
	}
	if err = file.Close(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkQuota(count); err != nil {
		return nil, err
	}
	verified, _, err := s.parent(full)
	if err != nil {
		return nil, err
	}
	a, errA := fileio.Stat(parent)
	b, errB := fileio.Stat(verified)
	verified.Close()
	if errA != nil || errB != nil || !os.SameFile(a, b) {
		return nil, fail("file_changed")
	}
	if err = fileio.Rename(parent, temp, parent, base); err != nil {
		return nil, mapError(err)
	}
	if err = fileio.SyncRoot(parent); err != nil {
		return nil, fail("durability_uncertain")
	}
	return metadata, nil
}
