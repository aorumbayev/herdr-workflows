package tui

import "strings"

// PasteLine flattens a clipboard paste into one field value. Newline, carriage
// return, and tab runs become one space. Other C0 bytes and DEL are dropped.
func PasteLine(s string) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		switch {
		case r == '\n' || r == '\r' || r == '\t':
			space = true
		case r < 0x20 || r == 0x7f:
		default:
			if space {
				b.WriteByte(' ')
				space = false
			}
			b.WriteRune(r)
		}
	}
	if space {
		b.WriteByte(' ')
	}
	return strings.TrimSpace(b.String())
}

// TrimLastRune removes the final rune, the backspace edit on a text field.
func TrimLastRune(s string) string {
	r := []rune(s)
	if len(r) == 0 {
		return s
	}
	return string(r[:len(r)-1])
}

// StepCursor moves a list cursor by delta, clamped to [0, n-1].
func StepCursor(cursor, delta, n int) int {
	return max(0, min(cursor+delta, n-1))
}
