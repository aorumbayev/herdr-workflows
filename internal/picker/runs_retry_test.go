package picker

import (
	"strings"
	"testing"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func retryPicker(t *testing.T, checkout string, launched *[]LaunchRunOpts, notes *[]string) Model {
	t.Helper()
	return New(Options{
		Entries:  []workflow.ListEntry{{Name: "demo", Source: "repo", File: checkout + "/demo.yaml", HasCommands: true}},
		RepoRoot: checkout,
		Width:    100,
		Height:   24,
		LaunchRun: func(opts LaunchRunOpts) LaunchRunHandle {
			*launched = append(*launched, opts)
			return LaunchRunHandle{}
		},
		Notify: func(_ string, body ...string) error { *notes = append(*notes, body...); return nil },
	})
}

func TestRunsRetryKeysLaunchTheRecordedRun(t *testing.T) {
	for _, tc := range []struct {
		key        string
		fromFailed bool
	}{{"r", false}, {"f", true}} {
		t.Run(tc.key, func(t *testing.T) {
			checkout := t.TempDir()
			t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
			id := seedFailedRun(t, checkout)
			var launched []LaunchRunOpts
			var notes []string
			m := apply(retryPicker(t, checkout, &launched, &notes), "tab", "enter", tc.key)
			if len(launched) != 1 {
				t.Fatalf("launched = %+v notes = %v", launched, notes)
			}
			got := launched[0]
			if got.Name != "demo" || got.RetryOf != id || got.FromFailed != tc.fromFailed || got.RunID == "" {
				t.Fatalf("launch = %+v, want retry of %s from-failed=%v", got, id, tc.fromFailed)
			}
			if m.runs.DetailKind() != "starting" {
				t.Fatalf("detail kind = %q, want starting", m.runs.DetailKind())
			}
			if body := m.runs.Body(); !strings.Contains(body, "commands") {
				t.Fatalf("retry launch must show the consent line:\n%s", body)
			}
		})
	}
}

func TestRunsRetryFromFailedRefusesASucceededRun(t *testing.T) {
	checkout := t.TempDir()
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	w := history.NewWriter()
	t.Cleanup(w.Dispose)
	if claimed := w.Claim(history.ClaimMeta{Workflow: "demo", Source: "repo", CheckoutRoot: checkout}); !claimed.OK {
		t.Fatalf("claim = %+v", claimed)
	}
	w.RecordStep(history.StepRecord{
		StepIdentity: history.StepIdentity{Phase: "main", Workflow: "demo", WorkflowPath: []string{"demo"}, Ordinal: 1, Total: 1, Action: "run", Label: "true"},
		FinishedAt:   time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Outcome:      "succeeded",
	})
	w.Finalize("succeeded", history.FinalizeOpts{})
	var launched []LaunchRunOpts
	var notes []string
	apply(retryPicker(t, checkout, &launched, &notes), "tab", "enter", "f")
	if len(launched) != 0 {
		t.Fatalf("launched = %+v, want none", launched)
	}
	if len(notes) != 1 || notes[0] != "nothing failed — r retries all steps" {
		t.Fatalf("notes = %v", notes)
	}
}

func TestRunsRetryRefusesAWorkflowMissingFromThisCheckout(t *testing.T) {
	checkout := t.TempDir()
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	seedFailedRun(t, checkout)
	var launched []LaunchRunOpts
	var notes []string
	m := New(Options{
		Entries:   []workflow.ListEntry{{Name: "other", Source: "repo"}},
		RepoRoot:  checkout,
		Width:     100,
		Height:    24,
		LaunchRun: func(opts LaunchRunOpts) LaunchRunHandle { launched = append(launched, opts); return LaunchRunHandle{} },
		Notify:    func(_ string, body ...string) error { notes = append(notes, body...); return nil },
	})
	apply(m, "tab", "enter", "r")
	if len(launched) != 0 || len(notes) != 1 || notes[0] != "workflow demo is not loadable in this checkout" {
		t.Fatalf("launched = %+v notes = %v", launched, notes)
	}
}
