package storage

import (
	"fmt"
	"strings"
	"testing"
)

func TestContentLineRangesPreserveBytesAndMetadata(t *testing.T) {
	source := "\ufefffirst\r\n\r\n第三行 📝\nlast\r"
	original := Content{Path: "note.md", Kind: "text", Content: source, Encoding: "utf-8", Revision: "original", Size: int64(len(source)), Mtime: "original-time"}
	cases := []struct {
		start, count     int
		want             string
		lines, end, next int
		more, partial    bool
	}{
		{1, 1, "\ufefffirst\r\n", 1, 1, 2, true, true},
		{2, 2, "\r\n第三行 📝\n", 2, 3, 4, true, true},
		{4, 100, "last\r", 1, 4, 0, false, true},
		{1, 100, source, 4, 4, 0, false, false},
		{5, 30, "", 0, 0, 0, false, true},
		{int(^uint(0) >> 1), 1, "", 0, 0, 0, false, true},
	}
	for _, tt := range cases {
		t.Run(fmt.Sprintf("%d-%d", tt.start, tt.count), func(t *testing.T) {
			got, err := original.LineRange(tt.start, tt.count)
			if err != nil {
				t.Fatal(err)
			}
			if got.Content.Content != tt.want || got.LineCount != tt.lines || got.EndLine != tt.end || got.NextLine != tt.next || got.HasMore != tt.more || got.IsPartial != tt.partial || got.TotalLines != 4 || got.StartLine != tt.start || got.RequestedLineCount != tt.count || got.ReturnedSize != len(tt.want) {
				t.Fatalf("不符：%+v", got)
			}
			if got.Size != original.Size || got.Revision != original.Revision || got.Mtime != original.Mtime || original.Content != source {
				t.Fatal("切片改变元数据或原内容")
			}
		})
	}
	for _, source := range []string{"", "\ufeff", "a", "a\n", "a\r\n", "a\r", "\n", "\n\n", "a\nb"} {
		content := Content{Content: source}
		got, err := content.LineRange(1, 100)
		if err != nil || got.Content.Content != source || got.IsPartial || got.HasMore {
			t.Fatalf("完整区间未保留原字节：%q %+v %v", source, got, err)
		}
		lines, _, err := splitSourceLines(strings.TrimPrefix(source, "\ufeff"))
		if err != nil || got.TotalLines != len(lines) {
			t.Fatal("行号与补丁定义不同", got, lines, err)
		}
	}
}
func TestLineRangePaginationAndValidation(t *testing.T) {
	var source strings.Builder
	for i := 1; i <= 231; i++ {
		fmt.Fprintf(&source, "line %d\n", i)
	}
	c := Content{Content: source.String()}
	var assembled strings.Builder
	for start := 1; start != 0; {
		result, err := c.LineRange(start, 100)
		if err != nil {
			t.Fatal(err)
		}
		assembled.WriteString(result.Content.Content)
		start = result.NextLine
	}
	if assembled.String() != source.String() {
		t.Fatal("分段拼接丢失／重复了内容")
	}
	for _, tt := range [][2]int{{0, 1}, {-1, 1}, {1, 0}, {1, -1}, {1, ReadLineLimit + 1}} {
		_, err := c.LineRange(tt[0], tt[1])
		code(t, err, "invalid_line_range")
	}
	// 行数超过补丁上限也可安全读取，不为全部逻辑行分配对象。
	huge := Content{Content: strings.Repeat("\n", PatchSourceLineLimit+1)}
	result, err := huge.LineRange(PatchSourceLineLimit, 1)
	if err != nil || result.TotalLines != PatchSourceLineLimit+1 || result.LineCount != 1 || result.Content.Content != "\n" {
		t.Fatal(result, err)
	}
}
