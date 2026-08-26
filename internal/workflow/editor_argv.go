package workflow

import (
	"fmt"
	"strings"
	"unicode"
)

// EditorArgv splits EDITOR into argv, honoring quotes, then appends path.
// Examples: `code --wait` and `nvim -c 'set ft=yaml'`.
func EditorArgv(editor, path string) ([]string, error) {
	fields, err := splitQuoted(editor)
	if err != nil {
		return nil, err
	}
	return append(fields, path), nil
}

func splitQuoted(s string) ([]string, error) {
	rs := []rune(s)
	var args []string
	var cur strings.Builder
	inSingle := false
	inDouble := false
	escape := false
	flush := func() {
		if cur.Len() == 0 {
			return
		}
		args = append(args, cur.String())
		cur.Reset()
	}
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		if escape {
			cur.WriteRune(r)
			escape = false
			continue
		}
		if inSingle {
			if r == '\'' {
				inSingle = false
				continue
			}
			cur.WriteRune(r)
			continue
		}
		if inDouble {
			next, closed, err := consumeDoubleQuoted(&cur, rs, i)
			if err != nil {
				return nil, err
			}
			i = next
			if closed {
				inDouble = false
			}
			continue
		}
		switch {
		case r == '\\':
			escape = true
		case r == '\'':
			inSingle = true
		case r == '"':
			inDouble = true
		case unicode.IsSpace(r):
			flush()
		default:
			cur.WriteRune(r)
		}
	}
	if escape || inSingle || inDouble {
		return nil, fmt.Errorf("unclosed quote in editor command")
	}
	flush()
	if len(args) == 0 {
		return nil, fmt.Errorf("editor command is empty")
	}
	return args, nil
}

func consumeDoubleQuoted(cur *strings.Builder, rs []rune, i int) (int, bool, error) {
	r := rs[i]
	if r == '"' {
		return i, true, nil
	}
	if r != '\\' {
		cur.WriteRune(r)
		return i, false, nil
	}
	if i+1 >= len(rs) {
		return 0, false, fmt.Errorf("unclosed quote in editor command")
	}
	next := rs[i+1]
	switch next {
	case '$', '`', '"', '\\', '\n':
		cur.WriteRune(next)
	default:
		cur.WriteRune('\\')
		cur.WriteRune(next)
	}
	return i + 1, false, nil
}
