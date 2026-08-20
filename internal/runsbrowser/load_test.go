package runsbrowser

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/history"
)

func testLoadEnv(t *testing.T) (stateDir, checkout string, getenv func(string) string) {
	t.Helper()
	stateDir = t.TempDir()
	checkout = t.TempDir()
	getenv = func(key string) string {
		if key == "HERDR_PLUGIN_STATE_DIR" {
			return stateDir
		}
		return os.Getenv(key)
	}
	return stateDir, checkout, getenv
}

func writeSucceededRun(t *testing.T, getenv func(string) string, checkout, workflow, startedAt string) string {
	t.Helper()
	w := history.NewWriter(getenv)
	t.Cleanup(w.Dispose)
	meta := history.ClaimMeta{
		Workflow:     workflow,
		Source:       "repo",
		CheckoutRoot: checkout,
	}
	if startedAt != "" {
		meta.StartedAt = startedAt
	}
	result := w.Claim(meta)
	if !result.OK || result.State != "claimed" {
		t.Fatalf("claim = %+v", result)
	}
	w.Finalize("succeeded", history.FinalizeOpts{})
	return w.ID()
}

func TestLoadPreservesSelection(t *testing.T) {
	_, checkout, getenv := testLoadEnv(t)
	keepFirstID := writeSucceededRun(t, getenv, checkout, "one", "2026-01-01T00:00:00.000Z")
	writeSucceededRun(t, getenv, checkout, "two", "2026-01-01T00:00:01.000Z")

	state := Load(checkout, ScopeCurrent, "", keepFirstID, getenv)
	if state.SelectedID != keepFirstID {
		t.Fatalf("SelectedID = %q, want %q", state.SelectedID, keepFirstID)
	}
	if !slices.ContainsFunc(state.Items, func(item history.ListItem) bool { return item.ID == keepFirstID }) {
		t.Fatalf("Items missing preserved id %q: %+v", keepFirstID, state.Items)
	}
}

func TestLoadCurrentScopeExact(t *testing.T) {
	_, checkoutA, getenv := testLoadEnv(t)
	checkoutB := t.TempDir()
	writeSucceededRun(t, getenv, checkoutA, "here", "")
	writeSucceededRun(t, getenv, checkoutB, "there", "")

	canonicalA, err := filepath.EvalSymlinks(checkoutA)
	if err != nil {
		t.Fatal(err)
	}

	current := Load(checkoutA, ScopeCurrent, "", "", getenv)
	for _, item := range current.Items {
		if item.CheckoutRoot != canonicalA {
			t.Fatalf("current item checkout_root = %q, want %q", item.CheckoutRoot, canonicalA)
		}
	}

	all := Load(checkoutA, ScopeAll, "", "", getenv)
	if len(all.Items) < 2 {
		t.Fatalf("all scope Items len = %d, want >= 2", len(all.Items))
	}
}

func TestLoadCurrentWithOnlyForeignRuns(t *testing.T) {
	_, checkout, getenv := testLoadEnv(t)
	foreign := t.TempDir()
	writeSucceededRun(t, getenv, foreign, "there", "")

	state := Load(checkout, ScopeCurrent, "", "", getenv)
	if state.Unavailable {
		t.Fatal("Unavailable = true, want false")
	}
	if len(state.Items) != 0 {
		t.Fatalf("Items len = %d, want 0", len(state.Items))
	}
	if !state.HasMachineRuns {
		t.Fatal("HasMachineRuns = false, want true")
	}
}
