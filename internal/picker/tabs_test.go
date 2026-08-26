package picker

import (
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

func TestFormatTabBarActiveReverseInactiveMuted(t *testing.T) {
	bar := FormatTabBar(tui.TabRuns, 80)
	for _, label := range []string{tui.TabWorkflows, tui.TabRuns, tui.TabProfiles} {
		if !strings.Contains(bar, label) {
			t.Fatalf("tab bar missing %q: %q", label, bar)
		}
	}
	if !strings.Contains(bar, tui.TabKeyPrefix) {
		t.Fatalf("tab bar must name the key: %q", bar)
	}
	if strings.Count(bar, "\x1b[7m") != 1 {
		t.Fatalf("exactly one tab must use reverse: %q", bar)
	}
	if strings.Count(bar, "\x1b[2m") != 3 {
		t.Fatalf("the key prefix and two inactive tabs must be faint: %q", bar)
	}
	if idx := strings.Index(bar, "\x1b[7m"); idx < 0 || !strings.HasPrefix(bar[idx:], "\x1b[7m "+tui.TabRuns) {
		t.Fatalf("reverse must land on the active tab: %q", bar)
	}
	if TabAtX(len(tui.TabKeyPrefix)) != tui.TabWorkflows {
		t.Fatalf("first tab hit = %q", TabAtX(len(tui.TabKeyPrefix)))
	}
	if TabAtX(0) != "" {
		t.Fatalf("the key prefix must not map to a tab: %q", TabAtX(0))
	}
	if got := TabAtX(len(tui.TabKeyPrefix) + len(tui.TabWorkflows) + 3); got != tui.TabRuns {
		t.Fatalf("runs hit = %q", got)
	}
}
