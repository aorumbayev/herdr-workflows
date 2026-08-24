package tui

import (
	"testing"

	"charm.land/lipgloss/v2"
)

func TestDefaultThemeUsesIndexedWarnMutedAndReverse(t *testing.T) {
	// This test copies test/picker/theme.test.ts against ticket 04 GAP 1: no OSC 4 palette query.
	theme := DefaultTheme()
	warn, ok := theme.Warn.GetForeground().(lipgloss.ANSIColor)
	if !ok || warn != WarnIndex {
		t.Fatalf("warn = %v", theme.Warn.GetForeground())
	}
	if !theme.Muted.GetFaint() {
		t.Fatal("muted must be faint so it follows the terminal foreground")
	}
	if isANSI(theme.Muted) {
		t.Fatalf("muted must not pin a palette slot, got %v", theme.Muted.GetForeground())
	}
	if !theme.Reverse.GetReverse() {
		t.Fatal("selection must use reverse video")
	}
}
