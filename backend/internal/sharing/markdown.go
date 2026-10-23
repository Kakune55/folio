package sharing

import (
	"bytes"
	"html"
	"net/url"
	"path"
	"regexp"
	"strings"

	"folio/internal/storage"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
	"sort"
)

func decodeDestination(href string) string {
	return html.UnescapeString(string(util.UnescapePunctuations([]byte(href))))
}
func Resolve(from, href string) (string, error) {
	href = decodeDestination(href)
	u, err := url.Parse(href)
	if err != nil {
		return "", err
	}
	if u.Scheme != "" || u.Host != "" || strings.HasPrefix(href, "//") || u.Path == "" {
		return "", nil
	}
	decoded := u.Path
	if strings.Contains(decoded, "\\") {
		return "", problem(400, "引用路径无效")
	}
	parts := []string{}
	if !strings.HasPrefix(decoded, "/") && path.Dir(from) != "." {
		parts = strings.Split(path.Dir(from), "/")
	}
	for _, p := range strings.Split(decoded, "/") {
		switch p {
		case "", ".":
		case "..":
			if len(parts) == 0 {
				return "", problem(400, "引用超出工作区")
			}
			parts = parts[:len(parts)-1]
		default:
			parts = append(parts, p)
		}
	}
	result := strings.Join(parts, "/")
	if err = storage.ValidPath(result, false); err != nil {
		return "", err
	}
	return result, nil
}
func markdown() goldmark.Markdown { return goldmark.New(goldmark.WithExtensions(extension.GFM)) }
func References(from string, data []byte) ([]string, []string) {
	doc := markdown().Parser().Parse(text.NewReader(data))
	refs := []string{}
	warnings := []string{}
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		var href []byte
		switch v := n.(type) {
		case *ast.Link:
			href = v.Destination
		case *ast.Image:
			href = v.Destination
		default:
			return ast.WalkContinue, nil
		}
		target, err := Resolve(from, string(href))
		if err != nil {
			warnings = append(warnings, "「"+from+"」中的引用不可用："+string(href))
		} else if target != "" {
			refs = append(refs, target)
		}
		return ast.WalkContinue, nil
	})
	return refs, warnings
}

// HTML 只作为展示产物；原始 Markdown 不改写、不序列化。Goldmark 默认禁用原始 HTML 与危险 URL。
func Render(from string, data []byte, token string, files []File) (string, error) {
	md := markdown()
	doc := md.Parser().Parse(text.NewReader(data))
	ids := map[string]string{}
	viewers := map[string]string{}
	for _, f := range files {
		ids[f.Path] = f.ID
		viewers[f.Path] = f.Viewer
	}
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		rewrite := func(href []byte, image bool) []byte {
			raw := string(href)
			target, err := Resolve(from, raw)
			if err == nil && ids[target] != "" {
				if image {
					if viewers[target] != "image" {
						return nil
					}
					return []byte("/api/v1/public/shares/" + token + "/files/" + ids[target] + "/preview")
				}
				return []byte("?file=" + ids[target])
			}
			if !image {
				u, e := url.Parse(decodeDestination(raw))
				if e == nil && (u.Scheme == "http" || u.Scheme == "https" || strings.HasPrefix(raw, "#")) {
					return []byte(decodeDestination(raw))
				}
				return []byte("#not-included")
			}
			return nil
		}
		switch v := n.(type) {
		case *ast.Link:
			v.Destination = rewrite(v.Destination, false)
		case *ast.Image:
			dest := rewrite(v.Destination, true)
			if dest == nil {
				n.Parent().ReplaceChild(n.Parent(), n, ast.NewString([]byte("[图片未包含或不可预览]")))
				return ast.WalkSkipChildren, nil
			}
			v.Destination = dest
		}
		return ast.WalkContinue, nil
	})
	var output bytes.Buffer
	err := md.Renderer().Render(&output, data, doc)
	return output.String(), err
}

// 转存只在解析器确认的 URL 字节区间修改；绝不对整篇正文做正则替换。
type sourceEdit struct {
	start, end int
	value      []byte
}
type trackedLinks struct {
	delegate parser.InlineParser
	collect  func(int, int, []byte)
}

func (p *trackedLinks) CloseBlock(parent ast.Node, reader text.Reader, ctx parser.Context) {
	p.delegate.(parser.CloseBlocker).CloseBlock(parent, reader, ctx)
}
func (p *trackedLinks) Trigger() []byte { return p.delegate.Trigger() }
func (p *trackedLinks) Parse(parent ast.Node, reader text.Reader, ctx parser.Context) ast.Node {
	_, before := reader.Position()
	node := p.delegate.Parse(parent, reader, ctx)
	var destination []byte
	var reference *ast.ReferenceLink
	switch n := node.(type) {
	case *ast.Link:
		destination = n.Destination
		reference = n.Reference
	case *ast.Image:
		destination = n.Destination
		reference = n.Reference
	default:
		return node
	}
	if reference != nil || !rootRelative(destination) {
		return node
	}
	_, after := reader.Position()
	end := after.Start
	if end < before.Start {
		end = len(reader.Source())
	}
	if before.Start >= 0 && end <= len(reader.Source()) {
		if offset := bytes.Index(reader.Source()[before.Start:end], destination); offset >= 0 {
			p.collect(before.Start+offset, before.Start+offset+len(destination), destination)
		}
	}
	return node
}
func rootRelative(dest []byte) bool {
	return len(dest) > 0 && dest[0] == '/' && !bytes.HasPrefix(dest, []byte("//"))
}

// 复杂引用标签不猜测位置；若仍有根引用，则明确拒绝转存，保留原件。
var referencePrefix = regexp.MustCompile(`^\[[^\\\]\r\n]+\]:[ \t\r\n]*<?`)

func Relocate(from string, data []byte) ([]byte, error) {
	edits := []sourceEdit{}
	collect := func(start, end int, dest []byte) {
		target, err := Resolve(from, string(dest))
		if err != nil || target == "" {
			return
		}
		u, err := url.Parse(decodeDestination(string(dest)))
		if err != nil {
			return
		}
		u.Path = storage.BundleDestination(from, target)
		u.RawPath = ""
		edits = append(edits, sourceEdit{start, end, []byte(u.String())})
	}
	inline := parser.DefaultInlineParsers()
	for i, value := range inline {
		if value.Priority == 200 {
			inline[i] = util.Prioritized(&trackedLinks{parser.NewLinkParser(), collect}, 200)
		}
	}
	md := goldmark.New(goldmark.WithParser(parser.NewParser(parser.WithBlockParsers(parser.DefaultBlockParsers()...), parser.WithInlineParsers(inline...), parser.WithParagraphTransformers(parser.DefaultParagraphTransformers()...))), goldmark.WithExtensions(extension.GFM))
	doc := md.Parser().Parse(text.NewReader(data))
	_ = ast.Walk(doc, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		n, ok := node.(*ast.LinkReferenceDefinition)
		if !entering || !ok || !rootRelative(n.Destination) || n.Lines().Len() == 0 {
			return ast.WalkContinue, nil
		}
		start := n.Pos()
		end := n.Lines().At(n.Lines().Len() - 1).Stop
		if start < 0 || end > len(data) {
			return ast.WalkContinue, nil
		}
		raw := data[start:end]
		prefix := referencePrefix.FindIndex(raw)
		if prefix != nil {
			if offset := bytes.Index(raw[prefix[1]:], n.Destination); offset >= 0 {
				begin := start + prefix[1] + offset
				collect(begin, begin+len(n.Destination), n.Destination)
			}
		}
		return ast.WalkContinue, nil
	})
	sort.Slice(edits, func(i, j int) bool { return edits[i].start > edits[j].start })
	result := append([]byte(nil), data...)
	last := len(data)
	for _, edit := range edits {
		if edit.start < 0 || edit.end > last || edit.start > edit.end {
			return nil, problem(422, "无法安全定位链接，请先将根引用改为相对路径再转存")
		}
		result = append(append(append([]byte{}, result[:edit.start]...), edit.value...), result[edit.end:]...)
		last = edit.start
	}
	var unresolved bool
	_ = ast.Walk(markdown().Parser().Parse(text.NewReader(result)), func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			switch n := node.(type) {
			case *ast.Link:
				unresolved = unresolved || rootRelative(n.Destination)
			case *ast.Image:
				unresolved = unresolved || rootRelative(n.Destination)
			}
		}
		return ast.WalkContinue, nil
	})
	if unresolved {
		return nil, problem(422, "此文档的根相对引用无法安全转换，请先改为相对路径再创建快照，或下载原文件")
	}
	return result, nil
}
