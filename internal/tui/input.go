package tui

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
