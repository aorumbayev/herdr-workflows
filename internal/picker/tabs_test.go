package picker

import (
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

func TestFormatTabBarActiveReverseInactiveMuted(t *testing.T) {
	bar := FormatTabBar(tui.TabRuns, 80)
	if !strings.Contains(bar, tui.TabWorkflows) || !strings.Contains(bar, tui.TabRuns) || !strings.Contains(bar, tui.TabConsole) {
		t.Fatalf("tab bar missing labels: %q", bar)
	}
	if strings.Count(bar, "\x1b[7m") != 1 {
		t.Fatalf("exactly one tab must use reverse: %q", bar)
	}
	if strings.Count(bar, "\x1b[2m") != 2 {
		t.Fatalf("both inactive tabs must be faint: %q", bar)
	}
	if idx := strings.Index(bar, "\x1b[7m"); idx < 0 || !strings.HasPrefix(bar[idx:], "\x1b[7m "+tui.TabRuns) {
		t.Fatalf("reverse must land on the active tab: %q", bar)
	}
	if TabAtX(0) != tui.TabWorkflows {
		t.Fatalf("x0 = %q", TabAtX(0))
	}
	if TabAtX(len(tui.TabWorkflows)+3) != tui.TabRuns {
		t.Fatalf("runs hit = %q", TabAtX(len(tui.TabWorkflows)+3))
	}
}
