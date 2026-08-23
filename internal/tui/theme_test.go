package tui

import (
	"testing"

	"charm.land/lipgloss/v2"
)

func TestDefaultThemeUsesIndexedWarnMutedAndReverse(t *testing.T) {
	// Ports test/picker/theme.test.ts against ticket 04 GAP 1: no OSC 4 palette query.
	theme := DefaultTheme()
	warn, ok := theme.Warn.GetForeground().(lipgloss.ANSIColor)
	if !ok || warn != WarnIndex {
		t.Fatalf("warn = %v", theme.Warn.GetForeground())
	}
	muted, ok := theme.Muted.GetForeground().(lipgloss.ANSIColor)
	if !ok || muted != MutedIndex {
		t.Fatalf("muted = %v", theme.Muted.GetForeground())
	}
	if !theme.Reverse.GetReverse() {
		t.Fatal("selection must use reverse video")
	}
}
