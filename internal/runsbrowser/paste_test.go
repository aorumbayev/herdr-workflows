package runsbrowser

import (
	"testing"

	tea "charm.land/bubbletea/v2"
)

func TestPasteMsgAppendsToActiveField(t *testing.T) {
	checkout := t.TempDir()
	m, _ := modelWithRuns(t, checkout, "alpha")
	next, _ := m.Update(tea.PasteMsg{Content: "dep"})
	if got := next.(Model).filter; got != "dep" {
		t.Fatalf("filter = %q", got)
	}
}

func TestPasteFlattensMultilineClipboard(t *testing.T) {
	checkout := t.TempDir()
	m, _ := modelWithRuns(t, checkout, "alpha")
	next, _ := m.Update(tea.PasteMsg{Content: "one\ntwo"})
	if got := next.(Model).filter; got != "one two" {
		t.Fatalf("filter = %q", got)
	}
}
