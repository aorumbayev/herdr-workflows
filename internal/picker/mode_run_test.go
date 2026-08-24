package picker

import (
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestAcceptLaunchNeverLeavesModeRun(t *testing.T) {
	entry := workflow.ListEntry{Name: "plain", Source: "repo", File: "/r/plain.yaml", Title: "Plain"}
	m := New(Options{
		Entries:  []workflow.ListEntry{entry},
		Width:    80,
		RepoRoot: t.TempDir(),
		LoadWorkflow: func(e workflow.ListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format, Title: "Plain",
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
		LaunchRun:     func(LaunchRunOpts) LaunchRunHandle { return LaunchRunHandle{Detach: func() {}} },
		AllocateRunID: func() string { return "550e8400-e29b-41d4-a716-446655440011" },
	})
	m = apply(m, "enter")
	if m.mode != modeRuns {
		t.Fatalf("accept/launch mode = %v, want modeRuns (modeRun is unreachable)", m.mode)
	}
	if strings.Contains(m.View().Content, "run continues") {
		t.Fatal("view still shows dead RunHint after launch")
	}
}
