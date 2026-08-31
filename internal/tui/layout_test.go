package tui

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestFormatListFooter(t *testing.T) {
	footer := FormatListFooter(60, 0, 2, ListHint)
	if !strings.Contains(footer, ListHint) || !strings.HasSuffix(footer, "1/2") || Columns(footer) != 60 {
		t.Fatalf("footer = %q (cols %d)", footer, Columns(footer))
	}
	if !strings.HasSuffix(FormatListFooter(60, 1, 2, ListHint), "2/2") {
		t.Fatal("counter uses selected index")
	}
	narrow := FormatListFooter(20, 0, 8, ListHint)
	if Columns(narrow) > 20 || !strings.HasSuffix(narrow, "1/8") {
		t.Fatalf("narrow = %q cols %d", narrow, Columns(narrow))
	}
	if FormatListFooter(60, 0, 0, EmptyListHint) != EmptyListHint {
		t.Fatalf("empty = %q", FormatListFooter(60, 0, 0, EmptyListHint))
	}
}

func TestFormatListFooterNarrowUnicodeStaysWithinColumns(t *testing.T) {
	hint := strings.Repeat("中", 20)
	for _, width := range []int{8, 12, 16, 24} {
		got := FormatListFooter(width, 0, 9, hint)
		if Columns(got) > width {
			t.Fatalf("width=%d footer cols %d > budget (%q)", width, Columns(got), got)
		}
		if !strings.HasSuffix(got, "1/9") {
			t.Fatalf("width=%d missing counter: %q", width, got)
		}
		if !utf8.ValidString(got) {
			t.Fatalf("width=%d invalid UTF-8: %q", width, got)
		}
	}
}

func TestFormatDetailBlockReservesTwoRows(t *testing.T) {
	got := strings.Split(FormatDetailBlock("hello", 60), "\n")
	if len(got) != DetailBlockHeight {
		t.Fatalf("detail block lines = %d", len(got))
	}
	if got[0] != "   hello" || got[1] != "" {
		t.Fatalf("short detail = %#v", got)
	}
}

func TestPadContentAddsHorizontalPadding(t *testing.T) {
	line := PadContentLine("abc", 3)
	if line != " abc " {
		t.Fatalf("padded = %q", line)
	}
	if StripContentPadding(line) != "abc" {
		t.Fatalf("stripped = %q", StripContentPadding(line))
	}
}

func TestFormatDetailLines(t *testing.T) {
	if FormatDetailLines("hello", 60) != "   hello" {
		t.Fatalf("short = %q", FormatDetailLines("hello", 60))
	}
	wrapped := FormatDetailLines("Distil this session transcript and hand it over", 34)
	lines := strings.Split(wrapped, "\n")
	if len(lines) != 2 || lines[0] != "   Distil this session" || lines[1] != "   transcript and hand it over" {
		t.Fatalf("wrap = %q", wrapped)
	}
	desc := "Distil this session's transcript and hand it to a fresh agent for review tomorrow"
	over := strings.Split(FormatDetailLines(desc, 40), "\n")
	if len(over) != 2 || strings.HasSuffix(over[0], "...") || !strings.HasSuffix(over[1], "...") {
		t.Fatalf("overlong = %q", FormatDetailLines(desc, 40))
	}
	unbreakable := strings.Split(FormatDetailLines(strings.Repeat("x", 80), 20), "\n")
	if len(unbreakable) != 2 || unbreakable[0] != "   "+strings.Repeat("x", 14) || unbreakable[1] != "   "+strings.Repeat("x", 11)+"..." {
		t.Fatalf("unbreakable = %q", FormatDetailLines(strings.Repeat("x", 80), 20))
	}
	if FormatDetailLines("", 60) != "" || FormatDetailLines("   \n\t  ", 60) != "" {
		t.Fatal("empty")
	}
	if FormatDetailLines("hello   world\n\nnext", 60) != "   hello world next" {
		t.Fatalf("collapse = %q", FormatDetailLines("hello   world\n\nnext", 60))
	}
	if !strings.Contains(FormatDetailLines("No workflows matching xyz", 80), "No workflows matching xyz") {
		t.Fatal("filter-miss copy")
	}
}

func TestFormatDetailLinesStayInsideBandB(t *testing.T) {
	// Detail text shares band B with list row titles and FormatRule: columns 3..W-4.
	const width = 60
	rule := FormatRule(width)
	last := strings.LastIndex(rule, "-")
	for _, text := range []string{
		strings.Repeat("word ", 40),
		strings.Repeat("x", 200),
	} {
		for _, line := range strings.Split(FormatDetailLines(text, width), "\n") {
			if Columns(line) > last+1 {
				t.Fatalf("detail line ends at column %d, past the rule at %d: %q", Columns(line)-1, last, line)
			}
		}
	}
}
