package history

import (
	"strings"
	"testing"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
	"github.com/aorumbayev/herdr-workflows/internal/engine"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

type retryPlanner interface {
	RecordRetryPlan(workflow.CollectedInputs, []string)
}

func retryWorkflow() workflow.Definition {
	return workflow.Definition{
		Name:      "m",
		RepoOwned: true,
		Steps: []workflow.Step{
			{ID: "probe", Action: workflow.RunAction{}},
			{Action: workflow.RunAction{}},
			{Action: workflow.WorkflowAction{Name: "c"}},
		},
	}
}

func recordFailedRun(t *testing.T, checkout string, retryOf string) string {
	t.Helper()
	wf := retryWorkflow()
	rec, err := CreateRunRecorder(CreateRecorderOpts{Workflow: wf, RunID: AllocateRunID(), CheckoutRoot: checkout, RetryOf: retryOf})
	if err != nil {
		t.Fatal(err)
	}
	defer rec.Dispose()
	rec.(retryPlanner).RecordRetryPlan(workflow.CollectedInputs{
		Values:  map[string]string{"who": "ada"},
		Domains: map[string][]string{"branch": {"main", "dev"}},
	}, []string{"f1", "f2", "f3"})
	ok := &engine.RecorderOutcome{OK: true, Result: map[string]any{"stdout": "hi", "exit_code": 0}}
	_ = rec.StepFinished(wf.Steps[0], 1, 3, "probe", engine.OutcomeSucceeded, ok, engine.PhaseMain)
	_ = rec.StepFinished(wf.Steps[1], 2, 3, "run", engine.OutcomeSkipped, &engine.RecorderOutcome{OK: true, Reused: true}, engine.PhaseMain)
	parent := 3
	child := rec.Child(engine.RecorderScope{Name: "c", WorkflowPath: []string{"m", "c"}, ParentOrdinal: &parent})
	nested := workflow.Step{ID: "inner", Action: workflow.RunAction{}}
	_ = child.StepFinished(nested, 1, 1, "inner", engine.OutcomeSucceeded, &engine.RecorderOutcome{OK: true, Result: "x"}, engine.PhaseMain)
	_ = rec.StepFinished(wf.Steps[2], 3, 3, "workflow: c", engine.OutcomeFailed, &engine.RecorderOutcome{Error: "boom"}, engine.PhaseMain)
	_ = rec.Finished(engine.StatusFailed, &engine.RecorderFinishExtras{Error: "boom"})
	return rec.RunID()
}

func TestLoadRetryRecordRoundTripsInputsFingerprintsAndTopLevelResults(t *testing.T) {
	_, checkout := testWriterEnv(t)
	source := AllocateRunID()
	id := recordFailedRun(t, checkout, source)

	got, err := LoadRetryRecord(id, time.Now())
	if err != nil {
		t.Fatalf("LoadRetryRecord: %v", err)
	}
	if got.Workflow != "m" || got.Status != "failed" || got.CheckoutRoot != CanonicalRepoRoot(checkout) {
		t.Fatalf("record = %+v", got)
	}
	if got.Inputs["who"] != "ada" || len(got.Domains["branch"]) != 2 || strings.Join(got.Source.Fingerprints, ",") != "f1,f2,f3" {
		t.Fatalf("plan = %v %v", got.Inputs, got.Source.Fingerprints)
	}
	if len(got.Source.Steps) != 3 {
		t.Fatalf("top-level steps = %+v, want 3 (nested excluded)", got.Source.Steps)
	}
	first := got.Source.Steps[0]
	result, _ := first.Result.(map[string]any)
	if first.StepID != "probe" || !first.HasResult || result["stdout"] != "hi" {
		t.Fatalf("step 1 = %+v", first)
	}
	if got.Source.Steps[2].Outcome != engine.OutcomeFailed || got.Source.Steps[2].HasResult {
		t.Fatalf("step 3 = %+v", got.Source.Steps[2])
	}
}

func TestRetrySnapshotKeepsRetryOfAndReusedMark(t *testing.T) {
	_, checkout := testWriterEnv(t)
	source := AllocateRunID()
	id := recordFailedRun(t, checkout, source)
	loaded, err := loadSnapshot(id)
	if err != nil || loaded.Snap == nil {
		t.Fatalf("loadSnapshot: %v %+v", err, loaded)
	}
	if loaded.Snap.RetryOf != source {
		t.Fatalf("RetryOf = %q, want %q", loaded.Snap.RetryOf, source)
	}
	if loaded.Snap.Steps[0].Reused || !loaded.Snap.Steps[1].Reused {
		t.Fatalf("reused marks = %+v", loaded.Snap.Steps)
	}
	blocks := PresentRunDetail(ToDetail(*loaded.Snap, time.Now()))
	found := false
	for _, b := range blocks {
		if b.Kind == "step" && b.Ordinal == 2 && b.Outcome == "skipped (reused)" {
			found = true
		}
	}
	if !found {
		t.Fatalf("blocks = %+v, want step 2 marked reused", blocks)
	}
}

func TestLoadRetryRecordRefusesRunsWithoutRetryData(t *testing.T) {
	_, checkout := testWriterEnv(t)
	rec, err := CreateRunRecorder(CreateRecorderOpts{Workflow: retryWorkflow(), RunID: AllocateRunID(), CheckoutRoot: checkout})
	if err != nil {
		t.Fatal(err)
	}
	_ = rec.Finished(engine.StatusFailed, nil)
	rec.Dispose()
	_, err = LoadRetryRecord(rec.RunID(), time.Now())
	if err == nil || !strings.Contains(err.Error(), "has no retry data") {
		t.Fatalf("err = %v", err)
	}
	_, err = LoadRetryRecord(AllocateRunID(), time.Now())
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("missing err = %v", err)
	}
	_, err = LoadRetryRecord("nope", time.Now())
	if err == nil || !strings.Contains(err.Error(), "complete UUID") {
		t.Fatalf("invalid err = %v", err)
	}
}

func TestOverCapRetryDataNamesSourceAndLimitOnLoad(t *testing.T) {
	_, checkout := testWriterEnv(t)
	wf := retryWorkflow()
	rec, err := CreateRunRecorder(CreateRecorderOpts{Workflow: wf, RunID: AllocateRunID(), CheckoutRoot: checkout})
	if err != nil {
		t.Fatal(err)
	}
	rec.(retryPlanner).RecordRetryPlan(workflow.CollectedInputs{Values: map[string]string{}}, []string{"f1", "f2", "f3"})
	big := &engine.RecorderOutcome{OK: true, Result: map[string]any{"stdout": strings.Repeat("x", caps.CaptureByteLimit)}}
	_ = rec.StepFinished(wf.Steps[0], 1, 3, "probe", engine.OutcomeSucceeded, big, engine.PhaseMain)
	_ = rec.Finished(engine.StatusFailed, nil)
	rec.Dispose()
	_, err = LoadRetryRecord(rec.RunID(), time.Now())
	if err == nil || !strings.Contains(err.Error(), "step 1 result") || !strings.Contains(err.Error(), "8388608") {
		t.Fatalf("err = %v, want cap error naming step 1 result and the limit", err)
	}

	rec2, err := CreateRunRecorder(CreateRecorderOpts{Workflow: wf, RunID: AllocateRunID(), CheckoutRoot: checkout})
	if err != nil {
		t.Fatal(err)
	}
	rec2.(retryPlanner).RecordRetryPlan(workflow.CollectedInputs{Values: map[string]string{"who": strings.Repeat("y", caps.CaptureByteLimit)}}, nil)
	_ = rec2.Finished(engine.StatusFailed, nil)
	rec2.Dispose()
	_, err = LoadRetryRecord(rec2.RunID(), time.Now())
	if err == nil || !strings.Contains(err.Error(), "retry plan") || strings.Contains(err.Error(), "predates") {
		t.Fatalf("err = %v, want cap error naming the retry plan", err)
	}
}
