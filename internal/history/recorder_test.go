package history

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/engine"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func demoWorkflow() workflow.Definition {
	return workflow.Definition{
		Name:      "m",
		RepoOwned: true,
		Steps:     []workflow.Step{{Action: workflow.RunAction{}}},
	}
}

func TestCreateRunRecorderRejectedAndUnavailable(t *testing.T) {
	_, checkout, getenv := testWriterEnv(t)
	id := AllocateRunID()
	first, err := CreateRunRecorder(CreateRecorderOpts{Workflow: demoWorkflow(), RunID: id, CheckoutRoot: checkout, Getenv: getenv})
	if err != nil || first == nil {
		t.Fatalf("first err=%v", err)
	}
	defer first.Dispose()
	var acks []string
	_, err = CreateRunRecorder(CreateRecorderOpts{
		Workflow: demoWorkflow(), RunID: id, CheckoutRoot: checkout, Getenv: getenv,
		OnAck: func(line string) { acks = append(acks, line) },
	})
	if err == nil {
		t.Fatal("expected rejected")
	}
	if len(acks) == 0 || ParseHistoryAck(acks[0]) == nil || ParseHistoryAck(acks[0]).State != "rejected" {
		t.Fatalf("acks %v", acks)
	}
	if runtime.GOOS == "windows" {
		return
	}
	state := t.TempDir()
	if err := os.WriteFile(filepath.Join(state, "marker"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(state, 0o755); err != nil {
		t.Fatal(err)
	}
	loose := func(key string) string {
		if key == "HERDR_PLUGIN_STATE_DIR" {
			return state
		}
		return os.Getenv(key)
	}
	var unavail []string
	rec, err := CreateRunRecorder(CreateRecorderOpts{
		Workflow: demoWorkflow(), CheckoutRoot: checkout, Getenv: loose,
		OnAck: func(line string) { unavail = append(unavail, line) },
	})
	if err != nil || rec == nil {
		t.Fatalf("unavailable recorder err=%v", err)
	}
	defer rec.Dispose()
	if ParseHistoryAck(unavail[0]).State != "unavailable" {
		t.Fatalf("acks %v", unavail)
	}
}

func TestRecorderFailureBeforeStepAndIdempotentFinish(t *testing.T) {
	_, checkout, getenv := testWriterEnv(t)
	rec, err := CreateRunRecorder(CreateRecorderOpts{Workflow: demoWorkflow(), CheckoutRoot: checkout, Getenv: getenv})
	if err != nil {
		t.Fatal(err)
	}
	defer rec.Dispose()
	msg := "input 'ref': missing launch payload domain snapshot"
	if err := rec.Finished(engine.StatusFailed, &engine.RecorderFinishExtras{Error: msg}); err != nil {
		t.Fatal(err)
	}
	if err := rec.Finished(engine.StatusSucceeded, nil); err != nil {
		t.Fatal(err)
	}
	listed := ListRuns(ListFilter{}, getenv)
	if !listed.OK || len(listed.Runs) != 1 {
		t.Fatalf("%+v", listed)
	}
	presented := RunDetail(rec.RunID(), getenv, time.Time{})
	if presented.Detail.Kind != "snapshot" || presented.Detail.Status != "failed" || presented.Detail.FailureExplanation != msg {
		t.Fatalf("%+v", presented.Detail)
	}
	found := false
	for _, b := range presented.Blocks {
		if b.Kind == "error" && b.Text == msg {
			found = true
		}
	}
	if !found {
		t.Fatalf("blocks %+v", presented.Blocks)
	}
}
