package tui

import "testing"

func TestTruncateEllipsisAtMax(t *testing.T) {
	// Ports test/picker/picker.test.ts "ellipsis at max".
	if got := Truncate("abcdefghij", 5); got != "ab..." {
		t.Fatalf("Truncate(%q, 5) = %q", "abcdefghij", got)
	}
	if got := Truncate("abcd", 5); got != "abcd" {
		t.Fatalf("Truncate(%q, 5) = %q", "abcd", got)
	}
}
