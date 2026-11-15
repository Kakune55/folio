// Package s3test 提供仅用于自动化验证的 S3 HTTP 协议模拟器，不代表真实云服务验收。
package s3test

import (
	"bufio"
	"bytes"
	"crypto/md5"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Object struct {
	Data  []byte
	ETag  string
	Mtime time.Time
}
type Server struct {
	Mu               sync.Mutex
	Objects          map[string]Object
	FailDelete       string
	FailPut          string
	IgnoreConditions bool
	Pages            int
}

func (f *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	key := strings.TrimPrefix(r.URL.Path, "/bucket/")
	fail := func(status int, code string) {
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(status)
		fmt.Fprintf(w, "<Error><Code>%s</Code></Error>", code)
	}
	if r.URL.Query().Get("list-type") == "2" {
		prefix := r.URL.Query().Get("prefix")
		var keys []string
		for k := range f.Objects {
			if strings.HasPrefix(k, prefix) {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		offset, _ := strconv.Atoi(r.URL.Query().Get("continuation-token"))
		end := min(offset+2, len(keys))
		if offset > end {
			fail(400, "InvalidArgument")
			return
		}
		f.Pages++
		type item struct {
			Key          string
			ETag         string
			Size         int
			LastModified string
		}
		out := struct {
			XMLName               xml.Name `xml:"ListBucketResult"`
			IsTruncated           bool
			NextContinuationToken string `xml:",omitempty"`
			Contents              []item
		}{IsTruncated: end < len(keys)}
		if out.IsTruncated {
			out.NextContinuationToken = strconv.Itoa(end)
		}
		for _, k := range keys[offset:end] {
			o := f.Objects[k]
			out.Contents = append(out.Contents, item{k, o.ETag, len(o.Data), o.Mtime.Format(time.RFC3339)})
		}
		w.Header().Set("Content-Type", "application/xml")
		xml.NewEncoder(w).Encode(out)
		return
	}
	old, exists := f.Objects[key]
	switch r.Method {
	case "PUT":
		if f.FailPut != "" && strings.Contains(key, f.FailPut) {
			fail(500, "InternalError")
			return
		}
		if !f.IgnoreConditions && (r.Header.Get("If-None-Match") == "*" && exists || r.Header.Get("If-Match") != "" && (!exists || r.Header.Get("If-Match") != old.ETag)) {
			fail(412, "PreconditionFailed")
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			fail(500, "InternalError")
			return
		}
		if strings.Contains(r.Header.Get("Content-Encoding"), "aws-chunked") {
			decoded, e := decodeAWSChunks(body)
			if e != nil {
				fail(400, "InvalidRequest")
				return
			}
			body = decoded
		}
		sum := md5.Sum(body)
		tag := "\"" + hex.EncodeToString(sum[:]) + "\""
		f.Objects[key] = Object{body, tag, time.Now().UTC().Truncate(time.Second)}
		w.Header().Set("ETag", tag)
	case "GET", "HEAD":
		if !exists {
			fail(404, "NoSuchKey")
			return
		}
		if tag := r.Header.Get("If-Match"); tag != "" && tag != old.ETag {
			fail(412, "PreconditionFailed")
			return
		}
		w.Header().Set("ETag", old.ETag)
		w.Header().Set("Content-Length", strconv.Itoa(len(old.Data)))
		w.Header().Set("Last-Modified", old.Mtime.Format(http.TimeFormat))
		sum := sha256.Sum256(old.Data)
		w.Header().Set("x-amz-checksum-sha256", base64.StdEncoding.EncodeToString(sum[:]))
		if r.Method == "GET" {
			w.Write(old.Data)
		}
	case "DELETE":
		if f.FailDelete != "" && strings.Contains(key, f.FailDelete) {
			fail(500, "InternalError")
			return
		}
		if !f.IgnoreConditions && exists && r.Header.Get("If-Match") != "" && r.Header.Get("If-Match") != old.ETag {
			fail(412, "PreconditionFailed")
			return
		}
		delete(f.Objects, key)
		w.WriteHeader(204)
	default:
		fail(400, "InvalidRequest")
	}
}

// SDK 使用 HTTP 签名流时，模拟器解码 S3 应用层分块；不把分块签名当成对象正文。
func decodeAWSChunks(data []byte) ([]byte, error) {
	reader := bufio.NewReader(bytes.NewReader(data))
	var decoded bytes.Buffer
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		part := strings.SplitN(strings.TrimSpace(line), ";", 2)[0]
		size, err := strconv.ParseInt(part, 16, 64)
		if err != nil || size < 0 || size > 1<<30 {
			return nil, fmt.Errorf("分块长度无效")
		}
		if size == 0 {
			return decoded.Bytes(), nil
		}
		if _, err = io.CopyN(&decoded, reader, size); err != nil {
			return nil, err
		}
		var end [2]byte
		if _, err = io.ReadFull(reader, end[:]); err != nil || string(end[:]) != "\r\n" {
			return nil, fmt.Errorf("分块结束符无效")
		}
	}
}
