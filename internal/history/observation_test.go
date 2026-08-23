package history

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSummaryIsPrivacyFilteredListProjection(t *testing.T) {
	now := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	iso := now.Add(-StaleAfter).UTC().Format("2006-01-02T15:04:05.000Z")
	exit := 3
	summary := ToSummary(Snapshot{
		Version:            SnapshotVersion,
		ID:                 validRunID,
		Workflow:           "demo",
		Title:              "Demo",
		Source:             "repo",
		CheckoutRoot:       "/repo/a",
		StartedAt:          iso,
		HeartbeatAt:        iso,
		FailureExplanation: "secret-token-xyz",
		Returns:            map[string]any{"token": "secret-token-xyz"},
		Steps: []StepRecord{{
			StepIdentity: StepIdentity{
				Phase: "main", Workflow: "demo", WorkflowPath: []string{"demo"},
				Ordinal: 1, Total: 1, Action: "run", Label: "shell",
			},
			FinishedAt:  iso,
			Outcome:     "failed",
			Failure:     &FailureFact{Action: "run", ExitCode: &exit},
			Explanation: "secret-token-xyz",
		}},
	}, now)
	if summary.ID != validRunID || summary.Status != "stale" || summary.Failure == nil || summary.Failure.ExitCode == nil || *summary.Failure.ExitCode != 3 {
		t.Fatalf("%+v", summary)
	}
	raw, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "secret-token-xyz") {
		t.Fatalf("Summary leaked private text: %s", raw)
	}
	if strings.Contains(string(raw), "returns") {
		t.Fatalf("Summary leaked returns: %s", raw)
	}
}

func TestToDetailReportsRemainingWithoutInventedIdentities(t *testing.T) {
	iso := validISO
	snap := Snapshot{
		Version: SnapshotVersion, ID: validRunID, Workflow: "demo", Source: "repo",
		CheckoutRoot: "/repo/a", StartedAt: iso, HeartbeatAt: iso, FinishedAt: iso, Status: "failed",
		Steps: []StepRecord{{
			StepIdentity: StepIdentity{
				Phase: "main", Workflow: "demo", WorkflowPath: []string{"demo"},
				Ordinal: 1, Total: 4, Action: "run", Label: "one",
			},
			FinishedAt: iso, Outcome: "failed",
		}},
	}
	detail := ToDetail(snap, time.Time{})
	if detail.Kind != "snapshot" {
		t.Fatalf("kind = %q", detail.Kind)
	}
	if detail.Remaining == nil || *detail.Remaining != 3 {
		t.Fatalf("remaining = %v", detail.Remaining)
	}
	if len(detail.Steps) != 1 || detail.Steps[0].Label != "one" {
		t.Fatalf("invented step identities: %+v", detail.Steps)
	}
}

func TestUnknownSnapshotVersionIsReportedAndLeftUntouched(t *testing.T) {
	_, _, getenv := testWriterEnv(t)
	id := AllocateRunID()
	body := []byte(`{"version":99,"id":"` + id + `","workflow":"old","source":"repo","checkout_root":"/repo/a","started_at":"2026-08-20T12:00:00.000Z","heartbeat_at":"2026-08-20T12:00:00.000Z","steps":[]}` + "\n")
	path := SnapshotPath(id, getenv)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	listed := ListRuns(ListFilter{}, getenv)
	if !listed.OK {
		t.Fatalf("list = %+v", listed)
	}
	for _, row := range listed.Runs {
		if row.ID == id {
			t.Fatal("incompatible snapshot was presented as a Summary")
		}
	}
	if len(listed.Incompatible) != 1 || listed.Incompatible[0].ID != id || listed.Incompatible[0].Version != 99 {
		t.Fatalf("incompatible = %+v", listed.Incompatible)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(body) {
		t.Fatal("incompatible snapshot file was mutated")
	}
	presented := RunDetail(id, getenv, time.Time{})
	if presented.Detail.Kind != "incompatible" {
		t.Fatalf("detail kind = %q", presented.Detail.Kind)
	}
	if !strings.Contains(presented.Detail.Message, "incompatible") {
		t.Fatalf("detail message = %q", presented.Detail.Message)
	}
}
