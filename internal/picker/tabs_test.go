package picker

import (
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

func TestFormatTabBarActiveReverseInactiveMuted(t *testing.T) {
	const width = 80
	bar := FormatTabBar(tui.TabRuns, width)
	for _, label := range []string{tui.TabWorkflows, tui.TabRuns, tui.TabProfiles} {
		if !strings.Contains(bar, label) {
			t.Fatalf("tab bar missing %q: %q", label, bar)
		}
	}
	if strings.Count(bar, "\x1b[7m") != 1 {
		t.Fatalf("exactly one tab must use reverse: %q", bar)
	}
	if strings.Count(bar, "\x1b[2m") != 2 {
		t.Fatalf("the two inactive tabs must be faint: %q", bar)
	}
	if idx := strings.Index(bar, "\x1b[7m"); idx < 0 || !strings.HasPrefix(bar[idx:], "\x1b[7m "+tui.TabRuns) {
		t.Fatalf("reverse must land on the active tab: %q", bar)
	}
	lead := len(bar) - len(strings.TrimLeft(bar, " "))
	if lead != tabBarOffset(width) || lead == 0 {
		t.Fatalf("tab row lead = %d, want the centering offset %d", lead, tabBarOffset(width))
	}
	if trail := width - lead - tabRowWidth(); trail != lead && trail != lead+1 {
		t.Fatalf("tab row is not centered: lead %d trail %d in width %d", lead, trail, width)
	}
	if got := TabAtX(lead, width); got != tui.TabWorkflows {
		t.Fatalf("first tab hit = %q", got)
	}
	if got := TabAtX(lead-1, width); got != "" {
		t.Fatalf("the pad before the tabs must not map to a tab: %q", got)
	}
	if got := TabAtX(lead+len(tui.TabWorkflows)+3, width); got != tui.TabRuns {
		t.Fatalf("runs hit = %q", got)
	}
}

func TestFormatTabBarNarrowWidthKeepsTabsFlushLeft(t *testing.T) {
	width := tabRowWidth()
	if got := tabBarOffset(width); got != 0 {
		t.Fatalf("a bar with no spare room must not pad, offset = %d", got)
	}
	if got := TabAtX(0, width); got != tui.TabWorkflows {
		t.Fatalf("first tab hit at a narrow width = %q", got)
	}
}
