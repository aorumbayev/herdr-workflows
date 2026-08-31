package tui

import "testing"

func TestTrimLastRune(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},
		{"a", ""},
		{"héllo", "héll"},
		{"日本", "日"},
	}
	for _, c := range cases {
		if got := TrimLastRune(c.in); got != c.want {
			t.Errorf("TrimLastRune(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestStepCursor(t *testing.T) {
	cases := []struct{ cursor, delta, n, want int }{
		{0, -1, 3, 0},
		{2, 1, 3, 2},
		{1, 1, 3, 2},
		{1, -1, 3, 0},
		{0, 1, 0, 0},
		{0, -1, 0, 0},
	}
	for _, c := range cases {
		if got := StepCursor(c.cursor, c.delta, c.n); got != c.want {
			t.Errorf("StepCursor(%d, %d, %d) = %d, want %d", c.cursor, c.delta, c.n, got, c.want)
		}
	}
}

func TestPasteLineFlattensNewlinesAndDropsC0(t *testing.T) {
	cases := []struct{ in, want string }{
		// bubbletea decodes control bytes into the paste: ultraviolet key_test.go:1185.
		{"a\x03\nb", "a b"},
		{"line one\r\nline two\tline three", "line one line two line three"},
		{"  padded  ", "padded"},
		{"a\x7fb", "ab"},
		{"keeps  inner spaces", "keeps  inner spaces"},
		{"", ""},
	}
	for _, c := range cases {
		if got := PasteLine(c.in); got != c.want {
			t.Errorf("PasteLine(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
