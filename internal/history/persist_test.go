package history

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestLaterWriteRecoversCompleteStateAfterMissedIntermediate(t *testing.T) {
	// Ports test/history/history-store.test.ts "later write recovers complete state after missed intermediate".
	_, checkout, getenv := testWriterEnv(t)
	w := NewWriter(getenv)
	defer w.Dispose()
	claimed := w.Claim(ClaimMeta{Workflow: "demo", Source: "repo", CheckoutRoot: checkout})
	if claimed.State != "claimed" {
		t.Fatalf("claim = %+v", claimed)
	}
	id := claimed.ID
	started := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	w.SetCurrentStep(CurrentStep{
		StepIdentity: StepIdentity{
			Phase: "main", Workflow: "demo", WorkflowPath: []string{"demo"},
			Ordinal: 1, Total: 2, Action: "run", Label: "one",
		},
		StartedAt: started,
	})
	if err := os.WriteFile(SnapshotPath(id, getenv), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	w.RecordStep(StepRecord{
		StepIdentity: StepIdentity{
			Phase: "main", Workflow: "demo", WorkflowPath: []string{"demo"},
			Ordinal: 1, Total: 2, Action: "run", Label: "one",
		},
		FinishedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Outcome:    "succeeded",
	})
	snap, err := ReadSnapshot(id, getenv)
	if err != nil {
		t.Fatal(err)
	}
	if snap == nil || len(snap.Steps) != 1 {
		t.Fatalf("steps = %+v", snap)
	}
	if snap.CurrentStep != nil {
		t.Fatalf("current_step = %+v", snap.CurrentStep)
	}
}

func TestQueuedPersistsDrainBeforeFinalizeWins(t *testing.T) {
	// Ports test/history/history-store.test.ts "queued persists drain before finalize wins".
	_, checkout, getenv := testWriterEnv(t)
	w := NewWriter(getenv)
	defer w.Dispose()
	claimed := w.Claim(ClaimMeta{Workflow: "demo", Source: "repo", CheckoutRoot: checkout})
	if claimed.State != "claimed" {
		t.Fatalf("claim = %+v", claimed)
	}
	started := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	done := make(chan struct{}, 3)
	go func() {
		w.SetCurrentStep(CurrentStep{
			StepIdentity: StepIdentity{
				Phase: "main", Workflow: "demo", WorkflowPath: []string{"demo"},
				Ordinal: 1, Total: 1, Action: "run", Label: "one",
			},
			StartedAt: started,
		})
		done <- struct{}{}
	}()
	go func() { w.Touch(); done <- struct{}{} }()
	go func() {
		w.RecordStep(StepRecord{
			StepIdentity: StepIdentity{
				Phase: "main", Workflow: "demo", WorkflowPath: []string{"demo"},
				Ordinal: 1, Total: 1, Action: "run", Label: "one",
			},
			FinishedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
			Outcome:    "succeeded",
		})
		done <- struct{}{}
	}()
	for range 3 {
		<-done
	}
	w.Finalize("succeeded", FinalizeOpts{})
	snap, err := ReadSnapshot(claimed.ID, getenv)
	if err != nil {
		t.Fatal(err)
	}
	if snap == nil || snap.Status != "succeeded" || len(snap.Steps) != 1 || snap.CurrentStep != nil {
		t.Fatalf("snapshot = %+v", snap)
	}
}

func TestFailedAtomicReplacementRemovesTemporarySnapshot(t *testing.T) {
	// Ports test/history/history-store.test.ts "failed atomic replacement removes temporary snapshot".
	_, checkout, getenv := testWriterEnv(t)
	w := NewWriter(getenv)
	defer w.Dispose()
	claimed := w.Claim(ClaimMeta{Workflow: "demo", Source: "repo", CheckoutRoot: checkout})
	if claimed.State != "claimed" {
		t.Fatalf("claim = %+v", claimed)
	}
	id := claimed.ID
	path := SnapshotPath(id, getenv)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	w.Touch()
	entries, err := os.ReadDir(RunsDir(getenv))
	if err != nil {
		t.Fatal(err)
	}
	prefix := "." + id + "."
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), prefix) && strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatalf("leftover tmp %s", e.Name())
		}
	}
	_ = os.RemoveAll(path)
}
