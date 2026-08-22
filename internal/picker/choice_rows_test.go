package picker

import (
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestChoiceRowsOmitLocationColumn(t *testing.T) {
	entry := workflow.WorkflowListEntry{Name: "branchy", Source: "repo", File: "/r/b.yaml", Title: "Branch check"}
	m := New(Options{
		Entries: []workflow.WorkflowListEntry{entry},
		Width:   80,
		Config:  config.Config{Profiles: map[string]config.Profile{}, Transcripts: map[string]config.TranscriptExtractor{}},
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
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
	for _, line := range strings.Split(m.View().Content, "\n") {
		if !strings.Contains(line, "alpha") && !strings.Contains(line, "beta") {
			continue
		}
		if strings.HasSuffix(strings.TrimRight(line, " "), "repo") {
			t.Fatalf("choice row must not show workflow location: %q", line)
		}
	}
}
