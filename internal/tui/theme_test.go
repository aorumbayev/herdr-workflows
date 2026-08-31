package tui

import (
	"strings"
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

func TestPlaceholderIsDimmerThanChrome(t *testing.T) {
	// Design 3: two independent mechanisms. Faint alone weighs the same as chrome.
	theme := DefaultTheme()
	slot, ok := theme.Placeholder.GetForeground().(lipgloss.ANSIColor)
	if !ok || slot != PlaceholderIndex {
		t.Fatalf("placeholder foreground = %v", theme.Placeholder.GetForeground())
	}
	if theme.Placeholder.GetFaint() {
		t.Fatal("faint on top of slot 8 renders too dark to read")
	}
	rendered := FormatField("", FilterRuns, 62)
	if !strings.Contains(rendered, "\x1b[") {
		t.Fatalf("empty field must style its placeholder, got %q", rendered)
	}
	if Columns(rendered) != Columns(FieldCursor+"  "+FilterRuns) {
		t.Fatalf("styling must not change cell width, got %d", Columns(rendered))
	}
	if MuteChrome(FilterRuns) == theme.Placeholder.Render(FilterRuns) {
		t.Fatal("placeholder must render differently from muted chrome")
	}
}
