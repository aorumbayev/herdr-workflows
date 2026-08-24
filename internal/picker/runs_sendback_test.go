package picker

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/console"
	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func seedFailedRun(t *testing.T, getenv func(string) string, checkout string) {
	t.Helper()
	w := history.NewWriter(getenv)
	t.Cleanup(w.Dispose)
	claimed := w.Claim(history.ClaimMeta{Workflow: "demo", Source: "repo", CheckoutRoot: checkout})
	if !claimed.OK {
		t.Fatalf("claim = %+v", claimed)
	}
	code := 2
	w.RecordStep(history.StepRecord{
		StepIdentity: history.StepIdentity{
			Phase: "main", Workflow: "demo", WorkflowPath: []string{"demo"},
			Ordinal: 1, Total: 1, Action: "run", Label: "false", StepID: "build",
		},
		FinishedAt:  time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Outcome:     "failed",
		Explanation: "secret-tail",
		Failure:     &history.FailureFact{Action: "run", ExitCode: &code, StepID: "build"},
	})
	w.Finalize("failed", history.FinalizeOpts{})
	_ = history.WriteDebugArtifacts(w.ID(), history.DebugArtifacts{
		EntryYAML: "version: v1alpha1\nsteps:\n  - id: build\n    run: [false]\n",
	}, getenv)
}

func TestRunsSendbackOmitsOutputTail(t *testing.T) {
	checkout := t.TempDir()
	stateDir := t.TempDir()
	getenv := func(key string) string {
		if key == "HERDR_PLUGIN_STATE_DIR" {
			return stateDir
		}
		return os.Getenv(key)
	}
	seedFailedRun(t, getenv, checkout)
	var sent string
	var notes []string
	m := New(Options{
		Entries:  []workflow.ListEntry{{Name: "demo", Source: "repo", File: checkout + "/demo.yaml"}},
		RepoRoot: checkout,
		Width:    100,
		Height:   24,
		Env:      getenv,
		ListAgentPanes: func() ([]console.AgentPaneEntry, error) {
			return []console.AgentPaneEntry{{PaneID: "a1", Title: "Claude"}}, nil
		},
		PaneSendText: func(_, text string) error { sent = text; return nil },
		Notify:       func(_ string, body ...string) error { notes = append(notes, body...); return nil },
	})
	m = apply(m, "tab", "enter", "s")
	if sent == "" {
		t.Fatalf("no send-back, mode=%v status=%q", m.mode, m.status)
	}
	if !strings.Contains(sent, "--- failure ---") || !strings.Contains(sent, "Cause:") {
		t.Fatalf("bundle:\n%s", sent)
	}
	if strings.Contains(sent, "secret-tail") {
		t.Fatalf("output tail leaked:\n%s", sent)
	}
	if len(notes) != 1 || notes[0] != "typed annotation" {
		t.Fatalf("runs tab hides the status row, so send-back must notify: %v", notes)
	}
}

func TestRunsSendbackAgentChooser(t *testing.T) {
	checkout := t.TempDir()
	stateDir := t.TempDir()
	getenv := func(key string) string {
		if key == "HERDR_PLUGIN_STATE_DIR" {
			return stateDir
		}
		return os.Getenv(key)
	}
	seedFailedRun(t, getenv, checkout)
	var sentPane string
	m := New(Options{
		Entries:  []workflow.ListEntry{{Name: "demo", Source: "repo", File: checkout + "/demo.yaml"}},
		RepoRoot: checkout,
		Width:    100,
		Height:   24,
		Env:      getenv,
		ListAgentPanes: func() ([]console.AgentPaneEntry, error) {
			return []console.AgentPaneEntry{
				{PaneID: "a1", Title: "One"},
				{PaneID: "a2", Title: "Two"},
			}, nil
		},
		PaneSendText: func(id, _ string) error { sentPane = id; return nil },
	})
	m = apply(m, "tab", "enter", "s")
	if m.mode != modeRunsAgentPick {
		t.Fatalf("mode = %v, want agent pick", m.mode)
	}
	m = apply(m, "down", "enter")
	if sentPane != "a2" {
		t.Fatalf("sent pane = %q", sentPane)
	}
}
