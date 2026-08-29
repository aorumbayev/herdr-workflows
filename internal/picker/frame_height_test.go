package picker

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestCompactFrameKeepsTabBarAsFirstLine(t *testing.T) {
	height, err := strconv.Atoi(compactHeight)
	if err != nil {
		t.Fatalf("compact height %q is not a number: %v", compactHeight, err)
	}
	m := New(Options{
		Entries: []workflow.ListEntry{{Name: "alpha", Title: "Alpha", Source: "repo"}},
		Width:   64,
		Height:  height,
	})
	body := m.View().Content
	lines := strings.Split(body, "\n")
	if len(lines) != height {
		t.Fatalf("compact frame = %d lines, want the popup height %d:\n%s", len(lines), height, body)
	}
	want := visibleLine(tui.PadContentLine(FormatTabBar(tui.TabWorkflows, m.contentWidth()), m.contentWidth()))
	if got := visibleLine(lines[0]); got != want {
		t.Fatalf("first rendered line = %q, want the tab bar %q:\n%s", got, want, body)
	}
}

func TestPickerFrameFitsPopupHeight(t *testing.T) {
	path := filepath.Join("..", "..", "examples", "handoff.yaml")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	def, err := workflow.ParseWorkflowText("handoff", string(body), config.Config{}, t.TempDir(), path)
	if err != nil {
		t.Fatal(err)
	}
	screens := []struct {
		name  string
		setup func(Model) Model
	}{
		{"workflows", func(m Model) Model { return m }},
		{"runs", func(m Model) Model { return apply(m, "tab") }},
	}
	for _, height := range []int{18, 24, 40} {
		for _, sc := range screens {
			m := New(Options{
				Entries:      []workflow.ListEntry{{Name: "handoff", Title: "Handoff", Source: "repo", File: path}},
				Width:        100,
				Height:       height,
				LoadWorkflow: func(entry workflow.ListEntry) (*workflow.Definition, error) { return def, nil },
			})
			m = sc.setup(m)
			lines := strings.Count(m.View().Content, "\n") + 1
			if lines > height {
				t.Fatalf("screen=%s height=%d frame=%d lines\n%s", sc.name, height, lines, m.View().Content)
			}
		}
	}
}

func TestStatusLineDoesNotChangeFrameHeight(t *testing.T) {
	// A frame that changes line count makes bubbletea erase and redraw the
	// whole inline frame. That looks like a blink.
	m := New(Options{Entries: []workflow.ListEntry{{Name: "alpha", Title: "Alpha", Source: "repo"}}, Width: 64, Height: 18})
	quiet := strings.Count(m.View().Content, "\n")
	m.status = "validated alpha"
	busy := strings.Count(m.View().Content, "\n")
	if quiet != busy {
		t.Fatalf("frame height changed with the status line: %d then %d", quiet+1, busy+1)
	}
	if quiet+1 != 18 {
		t.Fatalf("frame = %d lines, want the popup height 18", quiet+1)
	}
}
