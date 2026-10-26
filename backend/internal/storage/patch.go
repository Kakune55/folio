package storage

import (
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	PatchByteLimit       = 1 << 20
	PatchLineLimit       = 20000
	PatchHunkLimit       = 256
	PatchSourceLineLimit = 200000
)

type PatchResult struct {
	Path         string `json:"path"`
	Revision     string `json:"revision"`
	DryRun       bool   `json:"dryRun"`
	Changed      bool   `json:"changed"`
	AddedLines   int    `json:"addedLines"`
	DeletedLines int    `json:"deletedLines"`
	Size         int    `json:"size"`
}
type sourceLine struct{ text, ending string }
type patchLine struct {
	text      string
	kind      byte
	noNewline bool
}
type patchHunk struct {
	oldStart, oldCount, newStart, newCount int
	lines                                  []patchLine
}

var hunkHeader = regexp.MustCompile(`^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@(?: .*)?$`)

// Patch 先从原版本计算完整候选，再由既有条件写入复核；不发布部分 hunk。
func (s *Store) Patch(name, diff, revision string, dryRun bool) (*PatchResult, error) {
	if revision == "" {
		return nil, fail("precondition_required")
	}
	current, err := s.Read(name)
	if err != nil {
		return nil, err
	}
	if current.Revision != revision {
		return nil, &Error{Code: "revision_conflict", Revision: current.Revision}
	}
	candidate, added, deleted, err := applyUnifiedPatch(name, current.Content, diff, s.Limits().Text)
	if err != nil {
		return nil, err
	}
	result := &PatchResult{Path: name, Revision: revision, DryRun: dryRun, Changed: candidate != current.Content, AddedLines: added, DeletedLines: deleted, Size: len(candidate)}
	if !result.Changed {
		result.AddedLines, result.DeletedLines = 0, 0
	}
	if !dryRun && result.Changed {
		result.Revision, err = s.Write(name, candidate, revision, false)
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}

func parseUnifiedPatch(name, diff string) ([]patchHunk, error) {
	if len(diff) > PatchByteLimit || strings.Count(diff, "\n") > PatchLineLimit+PatchHunkLimit*2+4 {
		return nil, fail("patch_too_large")
	}
	if !utf8.ValidString(diff) || strings.ContainsRune(diff, 0) {
		return nil, fail("invalid_patch")
	}
	diff = strings.ReplaceAll(diff, "\r\n", "\n")
	if strings.ContainsRune(diff, '\r') {
		return nil, fail("invalid_patch")
	}
	lines := strings.Split(diff, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) >= 2 && strings.HasPrefix(lines[0], "--- ") {
		old := strings.SplitN(strings.TrimPrefix(lines[0], "--- "), "\t", 2)[0]
		if !strings.HasPrefix(lines[1], "+++ ") {
			return nil, fail("invalid_patch")
		}
		next := strings.SplitN(strings.TrimPrefix(lines[1], "+++ "), "\t", 2)[0]
		if (old != name && old != "a/"+name) || (next != name && next != "b/"+name) {
			return nil, fail("invalid_patch")
		}
		lines = lines[2:]
	}
	hunks := []patchHunk{}
	operations := 0
	for _, line := range lines {
		if strings.HasPrefix(line, "@@") {
			match := hunkHeader.FindStringSubmatch(line)
			if match == nil {
				return nil, fail("invalid_patch")
			}
			if len(hunks) >= PatchHunkLimit {
				return nil, fail("patch_too_large")
			}
			values := [4]int{}
			for i, raw := range match[1:5] {
				if raw == "" {
					values[i] = 1
					continue
				}
				value, err := strconv.Atoi(raw)
				if err != nil || value > PatchSourceLineLimit+PatchLineLimit {
					return nil, fail("invalid_patch")
				}
				values[i] = value
			}
			if (values[0] == 0 && values[1] != 0) || (values[2] == 0 && values[3] != 0) {
				return nil, fail("invalid_patch")
			}
			hunks = append(hunks, patchHunk{oldStart: values[0], oldCount: values[1], newStart: values[2], newCount: values[3]})
			continue
		}
		if len(hunks) == 0 {
			return nil, fail("invalid_patch")
		}
		h := &hunks[len(hunks)-1]
		if line == `\ No newline at end of file` {
			if len(h.lines) == 0 || h.lines[len(h.lines)-1].noNewline {
				return nil, fail("invalid_patch")
			}
			h.lines[len(h.lines)-1].noNewline = true
			continue
		}
		if len(line) == 0 || (line[0] != ' ' && line[0] != '+' && line[0] != '-') {
			return nil, fail("invalid_patch")
		}
		operations++
		if operations > PatchLineLimit {
			return nil, fail("patch_too_large")
		}
		h.lines = append(h.lines, patchLine{text: line[1:], kind: line[0]})
	}
	if len(hunks) == 0 || operations == 0 {
		return nil, fail("invalid_patch")
	}
	for _, h := range hunks {
		oldCount, newCount := 0, 0
		for _, line := range h.lines {
			if line.kind != '+' {
				oldCount++
			}
			if line.kind != '-' {
				newCount++
			}
		}
		if oldCount != h.oldCount || newCount != h.newCount {
			return nil, fail("invalid_patch")
		}
	}
	return hunks, nil
}

func splitSourceLines(source string) ([]sourceLine, string, error) {
	lines := []sourceLine{}
	firstEnding := ""
	start := 0
	for i := 0; i < len(source); i++ {
		if source[i] != '\r' && source[i] != '\n' {
			continue
		}
		end := i + 1
		if source[i] == '\r' && end < len(source) && source[end] == '\n' {
			end++
		}
		eol := source[i:end]
		lines = append(lines, sourceLine{source[start:i], eol})
		i = end - 1
		if firstEnding == "" {
			firstEnding = eol
		}
		start = end
		if len(lines) > PatchSourceLineLimit {
			return nil, "", fail("patch_too_large")
		}
	}
	if start < len(source) {
		lines = append(lines, sourceLine{source[start:], ""})
	}
	if len(lines) > PatchSourceLineLimit {
		return nil, "", fail("patch_too_large")
	}
	if firstEnding == "" {
		firstEnding = "\n"
	}
	return lines, firstEnding, nil
}

func applyUnifiedPatch(name, source, diff string, limit int64) (string, int, int, error) {
	hunks, err := parseUnifiedPatch(name, diff)
	if err != nil {
		return "", 0, 0, err
	}
	bom := ""
	if strings.HasPrefix(source, "\ufeff") {
		bom = "\ufeff"
		source = strings.TrimPrefix(source, "\ufeff")
	}
	old, ending, err := splitSourceLines(source)
	if err != nil {
		return "", 0, 0, err
	}
	output := make([]sourceLine, 0, len(old))
	cursor, previousAnchor, added, deleted := 0, -1, 0, 0
	for _, h := range hunks {
		anchor := h.oldStart
		if h.oldCount > 0 {
			anchor--
		}
		if anchor < cursor || anchor == previousAnchor {
			return "", 0, 0, fail("invalid_patch")
		}
		if anchor > len(old) || h.oldCount > len(old)-anchor {
			return "", 0, 0, fail("patch_mismatch")
		}
		output = append(output, old[cursor:anchor]...)
		cursor = anchor
		previousAnchor = anchor
		newAnchor := h.newStart
		if h.newCount > 0 {
			newAnchor--
		}
		if newAnchor != len(output) {
			return "", 0, 0, fail("invalid_patch")
		}
		removed := []sourceLine{}
		inserted := []patchLine{}
		flush := func() {
			for i, line := range inserted {
				eol := ending
				if i < len(removed) && removed[i].ending != "" {
					eol = removed[i].ending
				}
				if line.noNewline {
					eol = ""
				}
				output = append(output, sourceLine{line.text, eol})
			}
			removed = nil
			inserted = nil
		}
		for _, line := range h.lines {
			if line.kind == '+' {
				inserted = append(inserted, line)
				added++
				continue
			}
			if cursor >= len(old) || old[cursor].text != line.text || (old[cursor].ending == "") != line.noNewline {
				return "", 0, 0, fail("patch_mismatch")
			}
			if line.kind == ' ' {
				flush()
				output = append(output, old[cursor])
			} else {
				removed = append(removed, old[cursor])
				deleted++
			}
			cursor++
		}
		flush()
	}
	output = append(output, old[cursor:]...)
	if len(output) > PatchSourceLineLimit {
		return "", 0, 0, fail("patch_too_large")
	}
	if int64(len(bom)) > limit {
		return "", 0, 0, fail("too_large")
	}
	var builder strings.Builder
	builder.WriteString(bom)
	for i, line := range output {
		if line.ending == "" && i != len(output)-1 {
			return "", 0, 0, fail("invalid_patch")
		}
		if int64(builder.Len())+int64(len(line.text))+int64(len(line.ending)) > limit {
			return "", 0, 0, fail("too_large")
		}
		builder.WriteString(line.text)
		builder.WriteString(line.ending)
	}
	return builder.String(), added, deleted, nil
}
