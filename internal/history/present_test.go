package history

import (
	"testing"
	"time"
)

func TestPresentRunDetailInvalidAndEmpty(t *testing.T) {
	// These cases are the same as test/history/history-project.test.ts presentRunDetail cases.
	got := PresentRunDetail(Detail{Kind: "invalid", Message: "bad id"})
	if len(got) != 1 || got[0].Kind != "error" || got[0].Text != "bad id" {
		t.Fatalf("%+v", got)
	}
	got = PresentRunDetail(Detail{Kind: "missing", ID: "x", Message: "gone"})
	if len(got) != 1 || got[0].Text != "gone" {
		t.Fatalf("%+v", got)
	}
	blocks := PresentRunDetail(Detail{
		Kind: "snapshot", ID: "550e8400-e29b-41d4-a716-446655440099", DisplayID: "550e8400",
		Workflow: "demo", Source: "repo", CheckoutRoot: "/repo", Status: "succeeded", ElapsedMs: 1200,
	})
	found := false
	for _, b := range blocks {
		if b.Kind == "note" && b.Text == "no step outcomes yet" {
			found = true
		}
	}
	if !found {
		t.Fatalf("%+v", blocks)
	}
}

func TestPresentStaleRemainingTruncated(t *testing.T) {
	id := "550e8400-e29b-41d4-a716-446655440000"
	stale := PresentRunDetail(Detail{
		Kind: "snapshot", ID: id, DisplayID: id[:8], Workflow: "live", Source: "repo",
		CheckoutRoot: "/repo", Status: "stale",
	})
	found := false
	for _, b := range stale {
		if b.Kind == "note" && b.Text == "writer heartbeat stale - not a failure" {
			found = true
		}
	}
	if !found {
		t.Fatalf("stale banner missing: %+v", stale)
	}
	two := 2
	remaining := PresentRunDetail(Detail{
		Kind: "snapshot", ID: id, DisplayID: id[:8], Workflow: "partial", Source: "repo",
		CheckoutRoot: "/repo", Status: "failed", Remaining: &two, FailureExplanation: "boom",
		Steps: []DetailStep{{StepRecord: StepRecord{
			StepIdentity: StepIdentity{Phase: "main", Workflow: "partial", WorkflowPath: []string{"partial"}, Ordinal: 1, Total: 3, Action: "run", Label: "one"},
			Outcome:      "succeeded",
		}}},
	})
	notes := map[string]bool{}
	for _, b := range remaining {
		if b.Kind == "note" || b.Kind == "error" {
			notes[b.Text] = true
		}
	}
	if !notes["2 steps not run"] || !notes["boom"] {
		t.Fatalf("%+v", remaining)
	}
	truncated := PresentRunDetail(Detail{
		Kind: "snapshot", ID: "550e8400-e29b-41d4-a716-446655440777", DisplayID: "550e8400",
		Workflow: "reads", Source: "repo", CheckoutRoot: "/repo", Status: "succeeded",
		Steps: []DetailStep{{StepRecord: StepRecord{
			StepIdentity: StepIdentity{Phase: "main", Workflow: "reads", WorkflowPath: []string{"reads"}, Ordinal: 1, Total: 1, Action: "herdr", Label: "herdr pane.read"},
			Outcome:      "succeeded", Truncated: true,
		}}},
	})
	ok := false
	for _, b := range truncated {
		if b.Kind == "step" && b.Outcome == "succeeded (truncated read)" {
			ok = true
		}
	}
	if !ok {
		t.Fatalf("%+v", truncated)
	}
}

func TestProjectStatusHeartbeatAndTerminal(t *testing.T) {
	started := time.Now().Add(-time.Second)
	iso := started.UTC().Format("2006-01-02T15:04:05.000Z")
	snap := Snapshot{Version: 1, ID: validRunID, Workflow: "demo", Source: "repo", CheckoutRoot: "/repo/a", StartedAt: iso, HeartbeatAt: iso, Steps: []StepRecord{}}
	if ProjectStatus(snap, started.Add(time.Second)) != "running" {
		t.Fatal("running")
	}
	if ProjectStatus(snap, started.Add(StaleAfter)) != "stale" {
		t.Fatal("stale")
	}
	old := time.Now().Add(-time.Minute).UTC().Format("2006-01-02T15:04:05.000Z")
	term := snap
	term.StartedAt, term.HeartbeatAt, term.FinishedAt, term.Status = old, old, old, "succeeded"
	if ProjectStatus(term, time.Now()) != "succeeded" {
		t.Fatal("terminal")
	}
}

func TestToDetailGroupsNestedByParentOrdinal(t *testing.T) {
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	p1, p2 := 1, 2
	snap := Snapshot{
		Version: 1, ID: AllocateRunID(), Workflow: "m", Source: "repo", CheckoutRoot: "/repo/a",
		StartedAt: now, HeartbeatAt: now, FinishedAt: now, Status: "succeeded",
		Steps: []StepRecord{
			{StepIdentity: StepIdentity{Phase: "main", Workflow: "child1", WorkflowPath: []string{"m", "child1"}, Ordinal: 1, Total: 1, ParentOrdinal: &p1, Action: "run", Label: "inner1"}, FinishedAt: now, Outcome: "succeeded"},
			{StepIdentity: StepIdentity{Phase: "main", Workflow: "m", WorkflowPath: []string{"m"}, Ordinal: 1, Total: 2, Action: "workflow", Label: "wrap1"}, FinishedAt: now, Outcome: "succeeded"},
			{StepIdentity: StepIdentity{Phase: "main", Workflow: "child2", WorkflowPath: []string{"m", "child2"}, Ordinal: 1, Total: 1, ParentOrdinal: &p2, Action: "run", Label: "inner2"}, FinishedAt: now, Outcome: "succeeded"},
			{StepIdentity: StepIdentity{Phase: "main", Workflow: "m", WorkflowPath: []string{"m"}, Ordinal: 2, Total: 2, Action: "workflow", Label: "wrap2"}, FinishedAt: now, Outcome: "succeeded"},
		},
	}
	if !IsSnapshot(mustJSON(t, snap)) {
		t.Fatal("fixture must be a valid snapshot")
	}
	detail := ToDetail(snap, time.Time{})
	var labels []string
	for _, s := range detail.Steps {
		labels = append(labels, s.Label)
	}
	want := []string{"wrap1", "inner1", "wrap2", "inner2"}
	if len(labels) != 4 || labels[0] != want[0] || labels[1] != want[1] || labels[2] != want[2] || labels[3] != want[3] {
		t.Fatalf("labels = %v", labels)
	}
}

func mustJSON(t *testing.T, snap Snapshot) any {
	t.Helper()
	return asJSONValue(t, snap)
}
