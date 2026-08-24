package tui

import (
	"testing"

	"charm.land/lipgloss/v2"
)

func TestDefaultThemeKindPaletteAndHover(t *testing.T) {
	theme := DefaultTheme()
	cases := []struct {
		style lipgloss.Style
		index int
		name  string
	}{
		{theme.KindAgent, KindAgentIndex, "agent"},
		{theme.KindRun, KindRunIndex, "run"},
		{theme.KindHerdr, KindHerdrIndex, "herdr"},
		{theme.KindWorkflow, KindWorkflowIndex, "workflow"},
		{theme.KindDefault, KindDefaultIndex, "default"},
		{theme.Failed, FailIndex, "failed"},
		{theme.Succeeded, KindRunIndex, "succeeded"},
		{theme.Interrupted, WarnIndex, "interrupted"},
		{theme.Running, KindAgentIndex, "running"},
	}
	for _, tc := range cases {
		fg, ok := tc.style.GetForeground().(lipgloss.ANSIColor)
		if !ok || int(fg) != tc.index {
			t.Fatalf("%s = %v want ANSI %d", tc.name, tc.style.GetForeground(), tc.index)
		}
	}
	if !theme.Stale.GetFaint() || isANSI(theme.Stale) {
		t.Fatal("stale must be faint, not a palette slot")
	}
	if !theme.Reverse.GetReverse() {
		t.Fatal("selection must reverse")
	}
	if theme.Hover.GetReverse() {
		t.Fatal("hover must not reverse")
	}
	if !theme.Hover.GetUnderline() {
		t.Fatal("hover must underline")
	}
}

// isANSI is true for a style that pins one of the terminal palette slots.
func isANSI(style lipgloss.Style) bool {
	_, ok := style.GetForeground().(lipgloss.ANSIColor)
	return ok
}

func TestRunStatusStyleUsesLockedSlots(t *testing.T) {
	theme := DefaultTheme()
	for status, want := range map[string]int{
		"succeeded":   KindRunIndex,
		"failed":      FailIndex,
		"interrupted": WarnIndex,
		"running":     KindAgentIndex,
	} {
		fg, ok := theme.RunStatusStyle(status).GetForeground().(lipgloss.ANSIColor)
		if !ok || int(fg) != want {
			t.Fatalf("%s = %v want ANSI %d", status, theme.RunStatusStyle(status).GetForeground(), want)
		}
	}
	for _, status := range []string{"stale", "unknown"} {
		if !theme.RunStatusStyle(status).GetFaint() {
			t.Fatalf("%s must be faint, not a palette slot", status)
		}
	}
}

func TestKindStyleUsesLockedKindSlots(t *testing.T) {
	theme := DefaultTheme()
	for kind, want := range map[string]int{
		"agent":    KindAgentIndex,
		"run":      KindRunIndex,
		"herdr":    KindHerdrIndex,
		"workflow": KindWorkflowIndex,
		"other":    KindDefaultIndex,
	} {
		fg, ok := theme.KindStyle(kind).GetForeground().(lipgloss.ANSIColor)
		if !ok || int(fg) != want {
			t.Fatalf("%s = %v want ANSI %d", kind, theme.KindStyle(kind).GetForeground(), want)
		}
	}
}
