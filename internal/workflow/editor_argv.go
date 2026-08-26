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
	for _, r := range s {
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
			if r == '\\' {
				escape = true
				continue
			}
			if r == '"' {
				inDouble = false
				continue
			}
			cur.WriteRune(r)
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
