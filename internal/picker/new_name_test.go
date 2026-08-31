package picker

import (
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

func TestNewNameHintUsesASCIIChrome(t *testing.T) {
	m := New(Options{Width: 60, Height: 24})
	m.mode = modeNewName
	body := m.View().Content
	if !strings.Contains(body, tui.CreateNameHint) {
		t.Fatalf("missing create-name hint: %q", body)
	}
	if strings.Contains(body, "·") {
		t.Fatalf("create-name hint must not use middle dot: %q", body)
	}
}

func TestNameFieldsPutTheLabelOnItsOwnRow(t *testing.T) {
	// Canvas E and H: label row, value, edge, blank, hint. The inline labels
	// differed by one cell, which moved the edge for no reason but the wording.
	cases := []struct {
		name  string
		mode  mode
		label string
	}{
		{"workflow", modeNewName, "Workflow name"},
		{"profile", modeNewProfileName, "Profile name"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := New(Options{Width: 60, Height: 24})
			m.mode = c.mode
			m.promptValue = "my-deploy"
			w := m.contentWidth()
			lines := strings.Split(m.View().Content, "\n")
			if got := visibleLine(lines[0]); got != c.label {
				t.Fatalf("label row = %q want %q", got, c.label)
			}
			if got := visibleLine(lines[1]); got != tui.FormatFieldEdge(w) {
				t.Fatalf("top edge row = %q", got)
			}
			if got := visibleLine(lines[2]); got != tui.FieldCursor+"  my-deploy" {
				t.Fatalf("value row = %q", got)
			}
			if got := visibleLine(lines[3]); got != tui.FormatFieldEdge(w) {
				t.Fatalf("bottom edge row = %q", got)
			}
			if got := visibleLine(lines[len(lines)-1]); got != tui.CreateNameHint {
				t.Fatalf("hint must hold the last row, got %q", got)
			}
			if len(lines) != 24 {
				t.Fatalf("frame = %d lines, want the popup height 24", len(lines))
			}
			if strings.Contains(m.View().Content, c.label+":") {
				t.Fatalf("inline label survived:\n%s", m.View().Content)
			}
		})
	}
}
