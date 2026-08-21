package history

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/config"
)

func writeListedSnapshot(t *testing.T, getenv config.Env, snap map[string]any) {
	t.Helper()
	state, err := config.PluginStateDir(getenv)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(state, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(state, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(RunsDir(getenv), 0o700); err != nil {
		t.Fatal(err)
	}
	id, _ := snap["id"].(string)
	raw, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(SnapshotPath(id, getenv), append(raw, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}

func terminalSnapshot(id, workflow, root string, started time.Time, title string) map[string]any {
	iso := started.UTC().Format("2006-01-02T15:04:05.000Z")
	s := map[string]any{
		"version":       1,
		"id":            id,
		"workflow":      workflow,
		"source":        "repo",
		"checkout_root": root,
		"started_at":    iso,
		"heartbeat_at":  iso,
		"finished_at":   iso,
		"status":        "succeeded",
		"steps":         []any{},
	}
	if title != "" {
		s["title"] = title
	}
	return s
}

func TestFiltersApplyBeforeFortyResultLimit(t *testing.T) {
	// Ports test/history/history-store.test.ts "filters apply before forty-result limit".
	_, _, getenv := testWriterEnv(t)
	now := time.Now()
	for i := range 45 {
		writeListedSnapshot(t, getenv, terminalSnapshot(
			AllocateRunID(), "foreign", "/repo/other", now.Add(-time.Duration(i)*time.Second), "",
		))
	}
	currentID := AllocateRunID()
	writeListedSnapshot(t, getenv, terminalSnapshot(
		currentID, "mine", "/repo/a", now.Add(-50*time.Second), "",
	))
	root := "/repo/a"
	listed := ListRuns(ListFilter{CheckoutRoot: &root, Now: now}, getenv)
	if !listed.OK {
		t.Fatalf("list = %+v", listed)
	}
	found := false
	for _, r := range listed.Runs {
		if r.ID == currentID {
			found = true
		}
	}
	if !found {
		t.Fatal("current checkout run missing after forty newer foreign runs")
	}
	if len(listed.Runs) > 40 {
		t.Fatalf("len = %d", len(listed.Runs))
	}
}

func TestMalformedSnapshotsAreSkipped(t *testing.T) {
	// Ports test/history/history-store.test.ts "malformed snapshots are skipped".
	_, _, getenv := testWriterEnv(t)
	writeListedSnapshot(t, getenv, map[string]any{
		"version": 1, "id": AllocateRunID(), "workflow": "ok", "source": "repo",
		"checkout_root": "/repo/a",
		"started_at":    time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"heartbeat_at":  time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"finished_at":   time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"status":        "succeeded",
		"steps":         []any{},
	})
	if err := os.WriteFile(filepath.Join(RunsDir(getenv), "not-a-uuid.json"), []byte("{\"version\":1}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	nestedID := AllocateRunID()
	iso := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	writeListedSnapshot(t, getenv, map[string]any{
		"version": 1, "id": nestedID, "workflow": "demo", "source": "repo",
		"checkout_root": "/repo/a", "started_at": iso, "heartbeat_at": iso,
		"finished_at": iso, "status": "succeeded",
		"steps": []any{map[string]any{
			"phase": "main", "workflow": "child", "workflow_path": []any{"demo", "child"},
			"ordinal": 1, "total": 1, "action": "run", "label": "inner",
			"finished_at": iso, "outcome": "succeeded",
		}},
	})
	listed := ListRuns(ListFilter{}, getenv)
	if !listed.OK {
		t.Fatalf("list = %+v", listed)
	}
	for _, r := range listed.Runs {
		if r.ID == nestedID {
			t.Fatal("malformed nested snapshot was listed")
		}
	}
}

func TestPriorSharedLogIsIgnored(t *testing.T) {
	// Ports test/history/history-store.test.ts "prior shared runs.jsonl is ignored and left unchanged".
	stateDir, _, getenv := testWriterEnv(t)
	if err := os.Chmod(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	prior := filepath.Join(stateDir, "runs.jsonl")
	body := "{\"ts\":\"2020-01-01T00:00:00.000Z\",\"run\":\"abcd1234\",\"workflow\":\"old-log\",\"ok\":true}\n{not json\n"
	if err := os.WriteFile(prior, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	listed := ListRuns(ListFilter{}, getenv)
	if !listed.OK {
		t.Fatalf("list = %+v", listed)
	}
	for _, r := range listed.Runs {
		if r.Workflow == "old-log" {
			t.Fatal("shared log leaked into list")
		}
	}
	got, err := os.ReadFile(prior)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != body {
		t.Fatalf("shared log mutated")
	}
}

func TestSearchMatchesSafeLabelsNotExplanations(t *testing.T) {
	// Ports "search matches completed safe step labels" and "failure explanation is detail-only and not searchable".
	_, checkout, getenv := testWriterEnv(t)
	w := NewWriter(getenv)
	defer w.Dispose()
	if w.Claim(ClaimMeta{Workflow: "demo", Source: "repo", CheckoutRoot: checkout}).State != "claimed" {
		t.Fatal("claim")
	}
	iso := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	w.RecordStep(StepRecord{
		StepIdentity: StepIdentity{
			Phase: "main", Workflow: "demo", WorkflowPath: []string{"demo"},
			Ordinal: 1, Total: 1, Action: "run", Label: "unique-shell-label",
		},
		FinishedAt:  iso,
		Outcome:     "failed",
		Failure:     &FailureFact{Action: "run", ExitCode: intPtr(3)},
		Explanation: "secret-token-xyz",
	})
	w.Finalize("failed", FinalizeOpts{})
	canonical, err := filepath.EvalSymlinks(checkout)
	if err != nil {
		t.Fatal(err)
	}
	byLabel := ListRuns(ListFilter{Text: "unique-shell-label", CheckoutRoot: &canonical}, getenv)
	if !byLabel.OK || len(byLabel.Runs) != 1 {
		t.Fatalf("label search = %+v", byLabel)
	}
	secret := ListRuns(ListFilter{Text: "secret-token-xyz"}, getenv)
	if !secret.OK || len(secret.Runs) != 0 {
		t.Fatalf("explanation leaked into search: %+v", secret)
	}
	byExit := ListRuns(ListFilter{Text: "3", CheckoutRoot: &canonical}, getenv)
	if !byExit.OK || len(byExit.Runs) != 1 {
		t.Fatalf("exit search = %+v", byExit)
	}
	raw, err := json.Marshal(byExit.Runs[0])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "secret-token-xyz") {
		t.Fatal("list item contains explanation")
	}
}

func TestRetentionCountsOnlyTerminalAndPreservesActive(t *testing.T) {
	// Ports "retention byte budget counts only terminal snapshots".
	_, checkout, getenv := testWriterEnv(t)
	active := NewWriter(getenv)
	defer active.Dispose()
	if active.Claim(ClaimMeta{Workflow: "demo", Source: "repo", CheckoutRoot: checkout}).State != "claimed" {
		t.Fatal("active claim")
	}
	huge := map[string]any{
		"version": 1, "id": active.ID(), "workflow": "demo", "title": repeat("y", 400000),
		"source": "repo", "checkout_root": "/repo/a",
		"started_at":   time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"heartbeat_at": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"steps":        []any{},
	}
	writeListedSnapshot(t, getenv, huge)
	oldID, newID := AllocateRunID(), AllocateRunID()
	now := time.Now()
	writeListedSnapshot(t, getenv, terminalSnapshot(oldID, "old", "/repo/a", now.Add(-20*time.Second), repeat("z", 300000)))
	writeListedSnapshot(t, getenv, terminalSnapshot(newID, "new", "/repo/a", now.Add(-5*time.Second), repeat("z", 300000)))
	trigger := NewWriter(getenv)
	defer trigger.Dispose()
	if trigger.Claim(ClaimMeta{Workflow: "trigger", Source: "repo", CheckoutRoot: checkout}).State != "claimed" {
		t.Fatal("trigger claim")
	}
	trigger.Finalize("succeeded", FinalizeOpts{})
	if got, _ := ReadSnapshot(active.ID(), getenv); got == nil {
		t.Fatal("active snapshot deleted")
	}
	if got, _ := ReadSnapshot(newID, getenv); got == nil {
		t.Fatal("newest terminal deleted")
	}
	if got, _ := ReadSnapshot(oldID, getenv); got != nil {
		t.Fatal("oldest terminal should be gone")
	}
}

func TestDeletedCheckoutRemainsListable(t *testing.T) {
	// Ports "deleted checkout remains listable under soft canonical filter".
	_, checkout, getenv := testWriterEnv(t)
	canonical, err := filepath.EvalSymlinks(checkout)
	if err != nil {
		t.Fatal(err)
	}
	w := NewWriter(getenv)
	if w.Claim(ClaimMeta{Workflow: "demo", Source: "repo", CheckoutRoot: checkout}).State != "claimed" {
		t.Fatal("claim")
	}
	id := w.ID()
	w.Finalize("succeeded", FinalizeOpts{})
	w.Dispose()
	if err := os.RemoveAll(checkout); err != nil {
		t.Fatal(err)
	}
	listed := ListRuns(ListFilter{CheckoutRoot: &canonical}, getenv)
	if !listed.OK {
		t.Fatalf("list = %+v", listed)
	}
	found := false
	for _, r := range listed.Runs {
		if r.ID == id {
			found = true
		}
	}
	if !found {
		t.Fatal("deleted checkout snapshot missing under All/soft filter")
	}
}

func TestUnsafeSnapshotFileACLIsUnavailable(t *testing.T) {
	// Ports "unsafe snapshot file ACL is unavailable not missing" via ListRuns.
	if runtime.GOOS == "windows" {
		t.Skip("posix modes")
	}
	_, checkout, getenv := testWriterEnv(t)
	w := NewWriter(getenv)
	defer w.Dispose()
	if w.Claim(ClaimMeta{Workflow: "demo", Source: "repo", CheckoutRoot: checkout}).State != "claimed" {
		t.Fatal("claim")
	}
	id := w.ID()
	w.Finalize("succeeded", FinalizeOpts{})
	if err := os.Chmod(SnapshotPath(id, getenv), 0o644); err != nil {
		t.Fatal(err)
	}
	listed := ListRuns(ListFilter{}, getenv)
	if listed.OK || !listed.Unavailable {
		t.Fatalf("list = %+v", listed)
	}
}

func intPtr(n int) *int { return &n }

func repeat(s string, n int) string {
	b := make([]byte, 0, len(s)*n)
	for range n {
		b = append(b, s...)
	}
	return string(b)
}
