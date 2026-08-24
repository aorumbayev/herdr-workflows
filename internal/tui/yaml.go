package tui

import (
	"strings"
	"unicode"
)

func ColorYAML(src string) string {
	if src == "" {
		return ""
	}
	lines := strings.Split(strings.ReplaceAll(src, "\r\n", "\n"), "\n")
	blockBase := -1
	out := make([]string, len(lines))
	for i, line := range lines {
		out[i], blockBase = colorYAMLLine(line, blockBase)
	}
	return strings.Join(out, "\n")
}

func colorYAMLLine(line string, blockBase int) (string, int) {
	theme := DefaultTheme()
	if blockBase >= 0 {
		trim := strings.TrimSpace(line)
		if trim == "" {
			return line, blockBase
		}
		if yamlIndent(line) > blockBase {
			return line, blockBase
		}
		blockBase = -1
	}
	trim := strings.TrimSpace(line)
	if trim == "" {
		return line, blockBase
	}
	if strings.HasPrefix(trim, "#") {
		return theme.Muted.Render(line), blockBase
	}
	return colorYAMLMapping(line, blockBase, theme)
}

func colorYAMLMapping(line string, blockBase int, theme Theme) (string, int) {
	n := len(line)
	i := 0
	var b strings.Builder
	for i < n && (line[i] == ' ' || line[i] == '\t') {
		i++
	}
	b.WriteString(line[:i])
	if i+1 < n && line[i] == '-' && line[i+1] == ' ' {
		b.WriteString(theme.Muted.Render("- "))
		i += 2
		sp := i
		for i < n && (line[i] == ' ' || line[i] == '\t') {
			i++
		}
		b.WriteString(line[sp:i])
	}
	if i >= n {
		return b.String(), blockBase
	}
	if line[i] == '#' {
		b.WriteString(theme.Muted.Render(line[i:]))
		return b.String(), blockBase
	}
	colon := yamlUnquotedColon(line, i)
	if colon >= 0 {
		b.WriteString(theme.KindAgent.Render(line[i:colon]))
		b.WriteString(theme.Muted.Render(":"))
		i = colon + 1
		sp := i
		for i < n && (line[i] == ' ' || line[i] == '\t') {
			i++
		}
		b.WriteString(line[sp:i])
		if i >= n {
			return b.String(), blockBase
		}
		val, next := colorYAMLValue(line[i:], yamlIndent(line), theme)
		b.WriteString(val)
		return b.String(), next
	}
	val, next := colorYAMLValue(line[i:], yamlIndent(line), theme)
	b.WriteString(val)
	return b.String(), next
}

func colorYAMLBlock(body string, span int, theme Theme) string {
	rest := body[span:]
	styled := theme.Warn.Render(body[:span])
	if rest == "" {
		return styled
	}
	if strings.HasPrefix(strings.TrimSpace(rest), "#") {
		return styled + theme.Muted.Render(rest)
	}
	return styled + colorTemplates(rest, theme, false)
}

func colorYAMLValue(val string, lineIndent int, theme Theme) (string, int) {
	lead := 0
	for lead < len(val) && (val[lead] == ' ' || val[lead] == '\t') {
		lead++
	}
	prefix := val[:lead]
	body := val[lead:]
	if body == "" {
		return prefix, -1
	}
	if span, ok := yamlBlockSpan(body); ok {
		return prefix + colorYAMLBlock(body, span, theme), lineIndent
	}
	if body[0] == '"' || body[0] == '\'' {
		end := yamlQuoteEnd(body)
		quoted := colorTemplates(body[:end], theme, true)
		return prefix + quoted + colorYAMLAfter(body[end:], theme), -1
	}
	bare, after := yamlSplitBare(body)
	var styled string
	if yamlBareScalar(bare) {
		styled = theme.Warn.Render(bare)
	} else {
		styled = colorTemplates(bare, theme, false)
	}
	return prefix + styled + colorYAMLAfter(after, theme), -1
}

func colorYAMLAfter(s string, theme Theme) string {
	if s == "" {
		return ""
	}
	trim := strings.TrimLeft(s, " \t")
	lead := s[:len(s)-len(trim)]
	if strings.HasPrefix(trim, "#") {
		return lead + theme.Muted.Render(trim)
	}
	return colorTemplates(s, theme, false)
}

func colorTemplates(s string, theme Theme, quoted bool) string {
	if s == "" {
		return ""
	}
	var b strings.Builder
	i := 0
	for i < len(s) {
		start := strings.Index(s[i:], "{{")
		if start < 0 {
			b.WriteString(yamlBase(s[i:], theme, quoted))
			break
		}
		start += i
		b.WriteString(yamlBase(s[i:start], theme, quoted))
		endRel := strings.Index(s[start:], "}}")
		if endRel < 0 {
			b.WriteString(theme.KindHerdr.Render(s[start:]))
			break
		}
		end := start + endRel + 2
		b.WriteString(theme.KindHerdr.Render(s[start:end]))
		i = end
	}
	return b.String()
}

func yamlBase(s string, theme Theme, quoted bool) string {
	if s == "" {
		return ""
	}
	if quoted {
		return theme.KindRun.Render(s)
	}
	return s
}

func yamlQuoteEnd(body string) int {
	q := body[0]
	end := 1
	for end < len(body) {
		c := body[end]
		if q == '"' && c == '\\' && end+1 < len(body) {
			end += 2
			continue
		}
		if q == '\'' && c == '\'' && end+1 < len(body) && body[end+1] == '\'' {
			end += 2
			continue
		}
		if c == q {
			return end + 1
		}
		end++
	}
	return len(body)
}

func yamlSplitBare(s string) (bare, after string) {
	inSingle, inDouble := false, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inSingle {
			if c == '\'' {
				if i+1 < len(s) && s[i+1] == '\'' {
					i++
					continue
				}
				inSingle = false
			}
			continue
		}
		if inDouble {
			if c == '\\' && i+1 < len(s) {
				i++
				continue
			}
			if c == '"' {
				inDouble = false
			}
			continue
		}
		switch c {
		case '\'':
			inSingle = true
		case '"':
			inDouble = true
		case '#':
			if i == 0 || s[i-1] == ' ' || s[i-1] == '\t' {
				return s[:i], s[i:]
			}
		}
	}
	return s, ""
}

func yamlBlockSpan(s string) (int, bool) {
	if s == "" || (s[0] != '|' && s[0] != '>') {
		return 0, false
	}
	i := 1
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		i++
	}
	j := i
	for j < len(s) && (s[j] == ' ' || s[j] == '\t') {
		j++
	}
	if j < len(s) && s[j] != '#' {
		return 0, false
	}
	return i, true
}

func yamlBareScalar(s string) bool {
	switch s {
	case "true", "false", "null", "True", "False", "Null", "TRUE", "FALSE", "NULL", "~":
		return true
	}
	if s == "" {
		return false
	}
	i := 0
	if s[0] == '+' || s[0] == '-' {
		i++
		if i >= len(s) {
			return false
		}
	}
	digits := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
		digits++
	}
	if digits == 0 {
		return false
	}
	if i < len(s) && s[i] == '.' {
		i++
		frac := 0
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
			frac++
		}
		if frac == 0 {
			return false
		}
	}
	for i < len(s) && unicode.IsLetter(rune(s[i])) {
		i++
	}
	return i == len(s)
}

func yamlUnquotedColon(line string, start int) int {
	inSingle, inDouble := false, false
	for i := start; i < len(line); i++ {
		c := line[i]
		if inSingle {
			if c == '\'' {
				if i+1 < len(line) && line[i+1] == '\'' {
					i++
					continue
				}
				inSingle = false
			}
			continue
		}
		if inDouble {
			if c == '\\' && i+1 < len(line) {
				i++
				continue
			}
			if c == '"' {
				inDouble = false
			}
			continue
		}
		switch c {
		case '\'':
			inSingle = true
		case '"':
			inDouble = true
		case '#':
			return -1
		case ':':
			return i
		}
	}
	return -1
}

func yamlIndent(s string) int {
	i := 0
	for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
		i++
	}
	return i
}

func SplitStepYAML(body string) []string {
	lines := strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n")
	start := -1
	for i, line := range lines {
		if strings.HasPrefix(line, "steps:") {
			start = i + 1
			break
		}
	}
	if start < 0 {
		return nil
	}
	lines = lines[start:]
	marker := stepItemPrefix(lines)
	if marker == "" {
		return nil
	}
	indent := len(marker) - 1
	var chunks []string
	var cur []string
	for _, line := range lines {
		if isStepItem(line, marker) {
			if len(cur) > 0 {
				chunks = append(chunks, strings.TrimRight(strings.Join(cur, "\n"), "\n"))
			}
			cur = []string{line}
			continue
		}
		if line != "" && yamlIndent(line) <= indent {
			break
		}
		if len(cur) > 0 {
			cur = append(cur, line)
		}
	}
	if len(cur) > 0 {
		chunks = append(chunks, strings.TrimRight(strings.Join(cur, "\n"), "\n"))
	}
	return chunks
}

func isStepItem(line, marker string) bool {
	if !strings.HasPrefix(line, marker) {
		return false
	}
	rest := line[len(marker):]
	return rest == "" || rest[0] == ' '
}

// stepItemPrefix is the indent plus dash of the first sequence item under
// steps:, which every sibling item repeats exactly.
func stepItemPrefix(lines []string) string {
	for _, line := range lines {
		trim := strings.TrimSpace(line)
		if trim == "" || strings.HasPrefix(trim, "#") {
			continue
		}
		if !strings.HasPrefix(trim, "- ") && trim != "-" {
			return ""
		}
		return line[:yamlIndent(line)] + "-"
	}
	return ""
}
