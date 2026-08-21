package picker

import (
	"os"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestTabSwitchesBetweenWorkflowAndRunsBrowsers(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80, RepoRoot: t.TempDir()})
	if got := strings.Split(m.View().Content, "\n")[0]; got != tui.FilterWorkflows {
		t.Fatalf("workflows filter = %q", got)
	}
	m = apply(m, "tab")
	if m.mode != modeRuns {
		t.Fatalf("mode = %v", m.mode)
	}
	body := m.View().Content
	if !strings.Contains(body, tui.FilterRuns) && !strings.Contains(body, "filter runs") {
		t.Fatalf("runs filter missing:\n%s", body)
	}
	m = apply(m, "tab")
	if m.mode != modeList {
		t.Fatalf("mode after return = %v", m.mode)
	}
	if got := strings.Split(m.View().Content, "\n")[0]; got != tui.FilterWorkflows {
		t.Fatalf("workflows filter not restored = %q", got)
	}
}

func TestTabLoadsCurrentCheckoutRuns(t *testing.T) {
	stateDir := t.TempDir()
	checkout := t.TempDir()
	getenv := func(key string) string {
		if key == "HERDR_PLUGIN_STATE_DIR" {
			return stateDir
		}
		return os.Getenv(key)
	}
	w := history.NewWriter(getenv)
	t.Cleanup(w.Dispose)
	claimed := w.Claim(history.ClaimMeta{Workflow: "cycle8-tab", Source: "repo", CheckoutRoot: checkout})
	if !claimed.OK || claimed.State != "claimed" {
		t.Fatalf("claim = %+v", claimed)
	}
	w.Finalize("succeeded", history.FinalizeOpts{})

	m := New(Options{Entries: catalogEntries(), Width: 80, RepoRoot: checkout, Env: getenv})
	m = apply(m, "tab")
	body := m.View().Content
	if !strings.Contains(body, "cycle8-tab") {
		t.Fatalf("runs list missing workflow:\n%s", body)
	}
}

func TestTabDoesNotSwitchDuringInputCollection(t *testing.T) {
	entry := workflow.WorkflowListEntry{Name: "place", Source: "global", File: "/global/place.yaml"}
	m := New(Options{
		Entries:  []workflow.WorkflowListEntry{entry},
		Width:    80,
		RepoRoot: t.TempDir(),
		Config:   config.Config{Profiles: map[string]config.Profile{}, Transcripts: map[string]config.TranscriptExtractor{}},
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format,
				Inputs: []workflow.InputSpec{
					{Name: "unit", Type: "choice", Options: []string{"new", "existing"}},
				},
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
	})
	m = apply(m, "enter")
	if m.mode != modeInput {
		t.Fatalf("mode = %v", m.mode)
	}
	next, cmd := m.Update(press("tab"))
	m = next.(Model)
	if cmd != nil {
		if msg := cmd(); msg != nil {
			t.Fatalf("tab during input emitted %T", msg)
		}
	}
	if m.mode != modeInput {
		t.Fatalf("mode switched to %v", m.mode)
	}
}

func TestTabDoesNotSwitchDuringPalette(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80, RepoRoot: t.TempDir()})
	m = apply(m, "ctrl+k")
	next, cmd := m.Update(press("tab"))
	m = next.(Model)
	if cmd != nil {
		if msg := cmd(); msg != nil {
			t.Fatalf("tab during palette emitted %T", msg)
		}
	}
	if m.mode != modePalette {
		t.Fatalf("mode = %v", m.mode)
	}
}
