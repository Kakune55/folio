package storage

import "strings"

const ReadLineLimit = 1000

type LineContent struct {
	Content
	StartLine          int  `json:"startLine"`
	EndLine            int  `json:"endLine"`
	LineCount          int  `json:"lineCount"`
	RequestedLineCount int  `json:"requestedLineCount"`
	TotalLines         int  `json:"totalLines"`
	ReturnedSize       int  `json:"returnedSize"`
	HasMore            bool `json:"hasMore"`
	NextLine           int  `json:"nextLine"`
	IsPartial          bool `json:"isPartial"`
}

// LineRange 按与补丁一致的 LF/CRLF/CR 逻辑行切片，不修改原始字符或分隔符。
// 只记录所选区间的字节边界，不为全文每一行分配对象。
func (c Content) LineRange(startLine, count int) (*LineContent, error) {
	if startLine < 1 || count < 1 || count > ReadLineLimit {
		return nil, fail("invalid_line_range")
	}
	source := c.Content
	offset := 0
	if strings.HasPrefix(source, "\ufeff") {
		offset = 3
	}
	total, returned, start, end := 0, 0, -1, 0
	for i := offset; i < len(source); {
		lineStart := i
		for i < len(source) && source[i] != '\r' && source[i] != '\n' {
			i++
		}
		if i < len(source) {
			if source[i] == '\r' && i+1 < len(source) && source[i+1] == '\n' {
				i += 2
			} else {
				i++
			}
		}
		total++
		if total == startLine {
			start = lineStart
			if startLine == 1 {
				start = 0
			}
		}
		if total >= startLine && total-startLine < count {
			end = i
			returned++
		}
	}
	selected := ""
	if start >= 0 {
		selected = source[start:end]
	}
	// 空文件没有逻辑行；仅含 BOM 时，首段仍须保留该原始标记。
	if len(source) == offset && startLine == 1 {
		selected = source
	}
	result := &LineContent{Content: c, StartLine: startLine, LineCount: returned, RequestedLineCount: count, TotalLines: total, ReturnedSize: len(selected), IsPartial: startLine != 1 || returned < total}
	result.Content.Content = selected
	if returned > 0 {
		result.EndLine = startLine + returned - 1
	}
	result.HasMore = returned > 0 && result.EndLine < total
	if result.HasMore {
		result.NextLine = result.EndLine + 1
	}
	return result, nil
}
