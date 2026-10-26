package httpapi

import (
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"path"
	"time"
)

// 直到确认只有一个文件 part、请求未超限后，存储层才会提交临时文件。
type singleUpload struct {
	part   *multipart.Part
	reader *multipart.Reader
	done   bool
}

func (s *singleUpload) Read(buffer []byte) (int, error) {
	if s.done {
		return 0, io.EOF
	}
	n, err := s.part.Read(buffer)
	if err == io.EOF {
		extra, nextErr := s.reader.NextPart()
		if nextErr == io.EOF {
			s.done = true
			return n, io.EOF
		}
		if extra != nil {
			extra.Close()
		}
		if nextErr != nil {
			return n, nextErr
		}
		return n, errUploadShape
	}
	return n, err
}

var errUploadShape = errors.New("上传请求只能包含一个名为 file 的文件")

func (a *api) registerAttachments(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/files/metadata", a.protect(func(w http.ResponseWriter, r *http.Request) {
		metadata, err := a.Workspace.Metadata(r.URL.Query().Get("path"))
		if err != nil {
			storageError(w, err)
			return
		}
		writeJSON(w, 200, metadata)
	}))
	mux.HandleFunc("GET /api/v1/settings", a.protect(func(w http.ResponseWriter, r *http.Request) {
		limits := a.Workspace.Limits()
		writeJSON(w, 200, map[string]any{"limits": map[string]int64{"text": limits.Text, "image": limits.Image, "pdf": limits.PDF, "attachment": limits.Attachment, "imagePixels": limits.ImagePixels}})
	}))
	mux.HandleFunc("GET /api/v1/files/download", a.protect(func(w http.ResponseWriter, r *http.Request) { a.serveFile(w, r, false) }))
	mux.HandleFunc("GET /api/v1/files/preview", a.protect(func(w http.ResponseWriter, r *http.Request) { a.serveFile(w, r, true) }))
	mux.HandleFunc("POST /api/v1/uploads", a.protect(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, a.Workspace.Limits().Attachment+(64<<10))
		reader, err := r.MultipartReader()
		if err != nil {
			writeError(w, 400, "invalid_request", "需要 multipart/form-data 文件上传", nil)
			return
		}
		part, err := reader.NextPart()
		if err != nil {
			writeError(w, 400, "invalid_request", "上传文件缺失", nil)
			return
		}
		defer part.Close()
		_, parameters, err := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
		name := parameters["filename"]
		if err != nil || parameters["name"] != "file" || name == "" {
			writeError(w, 400, "invalid_request", errUploadShape.Error(), nil)
			return
		}
		metadata, err := a.Workspace.Upload(r.URL.Query().Get("directory"), name, &singleUpload{part: part, reader: reader}, r.URL.Query().Get("image") == "true")
		a.indexChange(r, err, path.Join(r.URL.Query().Get("directory"), name))
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				writeError(w, 413, "too_large", "上传文件超过大小限制", nil)
				return
			}
			if errors.Is(err, errUploadShape) || errors.Is(err, io.ErrUnexpectedEOF) {
				writeError(w, 400, "invalid_request", "上传请求不完整或包含多个文件", nil)
				return
			}
			storageError(w, err)
			return
		}
		writeJSON(w, 201, metadata)
	}))
}
func (a *api) serveFile(w http.ResponseWriter, r *http.Request, preview bool) {
	file, metadata, err := a.Workspace.OpenDownload(r.URL.Query().Get("path"), preview)
	if err != nil {
		storageError(w, err)
		return
	}
	defer file.Close()
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox; frame-ancestors 'none'")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	disposition := "attachment"
	media := "application/octet-stream"
	if preview {
		disposition = "inline"
		media = metadata.MediaType
	}
	w.Header().Set("Content-Type", media)
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": path.Base(metadata.Path)}))
	modified, _ := time.Parse(time.RFC3339Nano, metadata.Mtime)
	http.ServeContent(w, r, path.Base(metadata.Path), modified, file)
}
