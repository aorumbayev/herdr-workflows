package picker

import (
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestChoiceRowsOmitLocationColumn(t *testing.T) {
	entry := workflow.ListEntry{Name: "branchy", Source: "repo", File: "/r/b.yaml", Title: "Branch check"}
	m := New(Options{
		Entries: []workflow.ListEntry{entry},
		Width:   80,
		Config:  config.Config{Profiles: map[string]config.Profile{}, Transcripts: map[string]config.TranscriptExtractor{}},
		LoadWorkflow: func(e workflow.ListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format,
				Inputs: []workflow.InputSpec{
					{Name: "unit", Type: "choice", Options: []string{"alpha", "beta"}},
				},
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
	})
	m = apply(m, "enter")
	w := m.contentWidth()
	for _, rawLine := range strings.Split(m.View().Content, "\n") {
		line := tui.StripChromePadding(rawLine)
		for _, value := range []string{"alpha", "beta"} {
			if !strings.Contains(line, value) {
				continue
			}
			selected := strings.Contains(line, value) && strings.HasPrefix(line, "> ")
			want := FormatPickerRowName(value, "", false, w, selected)
			if line != want {
				t.Fatalf("choice row = %q want %q", line, want)
			}
		}
	}
}
