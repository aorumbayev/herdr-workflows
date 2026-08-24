package runsbrowser

import (
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"

	"github.com/aorumbayev/herdr-workflows/internal/history"
)

func writeFailedRun(t *testing.T, getenv func(string) string, checkout, workflow string) string {
	t.Helper()
	w := history.NewWriter(getenv)
	t.Cleanup(w.Dispose)
	claimed := w.Claim(history.ClaimMeta{Workflow: workflow, Source: "repo", CheckoutRoot: checkout})
	if !claimed.OK || claimed.State != "claimed" {
		t.Fatalf("claim = %+v", claimed)
	}
	code := 2
	finished := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	w.RecordStep(history.StepRecord{
		StepIdentity: history.StepIdentity{
			Phase: "main", Workflow: workflow, WorkflowPath: []string{workflow},
			Ordinal: 1, Total: 1, Action: "run", Label: "false", StepID: "build",
		},
		FinishedAt:  finished,
		Outcome:     "failed",
		Explanation: "secret-tail",
		Failure:     &history.FailureFact{Action: "run", ExitCode: &code, StepID: "build", Stream: "stderr"},
	})
	w.Finalize("failed", history.FinalizeOpts{})
	_ = history.WriteDebugArtifacts(w.ID(), history.DebugArtifacts{
		EntryYAML: "version: v1alpha1\nsteps:\n  - id: build\n    run: [false]\n",
	}, getenv)
	return w.ID()
}

func TestFailedRunDetailShowsCauseAndSource(t *testing.T) {
	checkout := t.TempDir()
	stateDir := t.TempDir()
	getenv := testGetenv(t, stateDir)
	writeFailedRun(t, getenv, checkout, "demo")
	m := New(Options{RepoRoot: checkout, Width: 100, Height: 24, Env: getenv})
	m = runCmd(m, m.Init())
	m = apply(m, "enter")
	body := ansi.Strip(m.View().Content)
	for _, want := range []string{"build", "run command failed", "exit 2", "secret-tail", "id: build"} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %q:\n%s", want, body)
		}
	}
}

func TestDetailPaneSplitsMultiLineOutputTail(t *testing.T) {
	step := history.DetailStep{StepRecord: history.StepRecord{
		StepIdentity: history.StepIdentity{Ordinal: 1, Action: "run", Label: "false", StepID: "build"},
		Outcome:      "failed",
		Explanation:  "first line\nsecond line\nthird line",
	}}
	lines := detailPaneLines(history.Detail{Status: "failed", Workflow: "demo"}, step, nil, 40)
	for _, line := range lines {
		if strings.Contains(line, "\n") {
			t.Fatalf("pane line carries a newline: %q", line)
		}
	}
	for _, want := range []string{"first line", "second line", "third line"} {
		found := false
		for _, line := range lines {
			if strings.Contains(ansi.Strip(line), want) {
				found = true
			}
		}
		if !found {
			t.Fatalf("missing %q in %v", want, lines)
		}
	}
}
