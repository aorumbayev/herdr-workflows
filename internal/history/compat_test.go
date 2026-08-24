package history

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestRealInstallSnapshotReadsUnmodified(t *testing.T) {
	// The fixture is a run snapshot from an install. checkout_root
	// is a neutral path.
	raw, err := os.ReadFile(filepath.Join("testdata", "ts-snapshot.json"))
	if err != nil {
		t.Fatal(err)
	}
	state := t.TempDir()
	if err := os.Chmod(state, 0o700); err != nil {
		t.Fatal(err)
	}
	getenv := func(key string) string {
		if key == "HERDR_PLUGIN_STATE_DIR" {
			return state
		}
		return os.Getenv(key)
	}
	id := "5da1aa28-f1c3-410f-9cfc-e6ecd75c356e"
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	parsed, ok := parseSnapshotValue(v)
	if !ok {
		t.Fatal("fixture is not a snapshot")
	}
	if err := insertClaim(parsed, getenv); err != nil {
		t.Fatal(err)
	}
	leftover := filepath.Join(legacyRunsDir(getenv), id+".json")
	if err := os.MkdirAll(filepath.Dir(leftover), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(leftover, []byte(`{"version":1,"id":"`+id+`","workflow":"ignored"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	snap, err := ReadSnapshot(id, getenv)
	if err != nil || snap == nil {
		t.Fatalf("read err=%v snap=%v", err, snap)
	}
	if snap.ID != id || snap.Workflow != "implement" || snap.Source != "global" {
		t.Fatalf("%+v", snap)
	}
	if snap.Status != "failed" || snap.CheckoutRoot != "/Users/example/project" {
		t.Fatalf("%+v", snap)
	}
	if snap.FailureExplanation != "step 0: input 'target' must be one of: claude, codex, cursor, opencode" {
		t.Fatalf("explanation %q", snap.FailureExplanation)
	}
	listed := ListRuns(ListFilter{}, getenv)
	if !listed.OK || len(listed.Runs) != 1 || listed.Runs[0].ID != id {
		t.Fatalf("list %+v", listed)
	}
}
