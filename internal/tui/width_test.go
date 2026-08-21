package tui

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestTruncateEllipsisAtMax(t *testing.T) {
	// Ports test/picker/picker.test.ts "ellipsis at max".
	if got := Truncate("abcdefghij", 5); got != "ab..." {
		t.Fatalf("Truncate(%q, 5) = %q", "abcdefghij", got)
	}
	if got := Truncate("abcd", 5); got != "abcd" {
		t.Fatalf("Truncate(%q, 5) = %q", "abcd", got)
	}
}

func TestPadHeight(t *testing.T) {
	// PadHeight fills unused TTY rows so prior-frame ghost lines cannot survive a naive capture.
	if got := PadHeight("a\nb", 5); got != "a\nb\n\n\n" {
		t.Fatalf("PadHeight short = %q", got)
	}
	if got := PadHeight("a\nb\nc", 2); got != "a\nb\nc" {
		t.Fatalf("PadHeight tall = %q", got)
	}
	if got := PadHeight("solo", 0); got != "solo" {
		t.Fatalf("PadHeight zero = %q", got)
	}
}

func TestTruncateUsesColumnsNotBytes(t *testing.T) {
	cjk := strings.Repeat("中", 8)
	if Columns(cjk) != 16 {
		t.Fatalf("Columns(%q) = %d want 16", cjk, Columns(cjk))
	}
	got := Truncate(cjk, 5)
	if Columns(got) > 5 {
		t.Fatalf("Truncate CJK cols %d > 5 (%q)", Columns(got), got)
	}
	if !utf8.ValidString(got) {
		t.Fatalf("Truncate CJK invalid UTF-8 %q", got)
	}
	if got != "中..." {
		t.Fatalf("Truncate CJK = %q want %q", got, "中...")
	}

	emoji := strings.Repeat("😀", 6)
	gotEmoji := Truncate(emoji, 5)
	if Columns(gotEmoji) > 5 || !utf8.ValidString(gotEmoji) {
		t.Fatalf("Truncate emoji = %q cols %d", gotEmoji, Columns(gotEmoji))
	}
	if gotEmoji != "😀..." {
		t.Fatalf("Truncate emoji = %q want %q", gotEmoji, "😀...")
	}

	// A 1-byte slice of the first CJK rune is invalid UTF-8; column cut must not.
	raw := "世界"
	byteCut := raw[:1]
	if utf8.ValidString(byteCut) {
		t.Fatalf("fixture %q unexpectedly valid", byteCut)
	}
	colCut := Truncate(raw, 2)
	if !utf8.ValidString(colCut) || Columns(colCut) > 2 {
		t.Fatalf("column cut = %q cols %d", colCut, Columns(colCut))
	}
}
