package history

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRealInstallSnapshotReadsUnmodified(t *testing.T) {
	// Fixture is a run snapshot from a real install, with checkout_root
	// replaced by a neutral path.
	raw, err := os.ReadFile(filepath.Join("testdata", "ts-snapshot.json"))
	if err != nil {
		t.Fatal(err)
	}
	state := t.TempDir()
	if err := os.Chmod(state, 0o700); err != nil {
		t.Fatal(err)
	}
	runs := filepath.Join(state, "runs")
	if err := os.Mkdir(runs, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(runs, "5da1aa28-f1c3-410f-9cfc-e6ecd75c356e.json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	getenv := func(key string) string {
		if key == "HERDR_PLUGIN_STATE_DIR" {
			return state
		}
		return os.Getenv(key)
	}
	id := "5da1aa28-f1c3-410f-9cfc-e6ecd75c356e"
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
