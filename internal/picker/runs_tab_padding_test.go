package picker

import (
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

func TestPickerRunsTabPadsContentOnce(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80, Height: 13, RepoRoot: t.TempDir()})
	m = apply(m, "tab")
	body := m.View().Content
	if got := tui.StripContentPadding(strings.Split(body, "\n")[2]); got != tui.FormatField("", tui.FilterRuns, 78) {
		t.Fatalf("filter row = %q", got)
	}
	for i, line := range strings.Split(body, "\n") {
		stripped := tui.StripContentPadding(line)
		if strings.Contains(stripped, "----") && strings.HasSuffix(stripped, tui.Ellipsis) {
			t.Fatalf("rule line %d truncated by double padding: %q", i, line)
		}
	}
}
