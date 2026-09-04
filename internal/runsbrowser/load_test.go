package runsbrowser

import (
	"path/filepath"
	"slices"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/history"
)

func testLoadEnv(t *testing.T) (stateDir, checkout string) {
	t.Helper()
	stateDir = t.TempDir()
	checkout = t.TempDir()
	t.Setenv("HERDR_PLUGIN_STATE_DIR", stateDir)
	return stateDir, checkout
}

func writeSucceededRun(t *testing.T, checkout, workflow, startedAt string) string {
	t.Helper()
	w := history.NewWriter()
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
	_, checkout := testLoadEnv(t)
	keepFirstID := writeSucceededRun(t, checkout, "one", "2026-01-01T00:00:00.000Z")
	writeSucceededRun(t, checkout, "two", "2026-01-01T00:00:01.000Z")

	state := Load(checkout, ScopeCurrent, "", keepFirstID)
	if state.SelectedID != keepFirstID {
		t.Fatalf("SelectedID = %q, want %q", state.SelectedID, keepFirstID)
	}
	if !slices.ContainsFunc(state.Items, func(item history.Summary) bool { return item.ID == keepFirstID }) {
		t.Fatalf("Items missing preserved id %q: %+v", keepFirstID, state.Items)
	}
}

func TestLoadCurrentScopeExact(t *testing.T) {
	_, checkoutA := testLoadEnv(t)
	checkoutB := t.TempDir()
	writeSucceededRun(t, checkoutA, "here", "")
	writeSucceededRun(t, checkoutB, "there", "")

	canonicalA, err := filepath.EvalSymlinks(checkoutA)
	if err != nil {
		t.Fatal(err)
	}

	current := Load(checkoutA, ScopeCurrent, "", "")
	for _, item := range current.Items {
		if item.CheckoutRoot != canonicalA {
			t.Fatalf("current item checkout_root = %q, want %q", item.CheckoutRoot, canonicalA)
		}
	}

	all := Load(checkoutA, ScopeAll, "", "")
	if len(all.Items) < 2 {
		t.Fatalf("all scope Items len = %d, want >= 2", len(all.Items))
	}
}

func TestLoadCurrentWithOnlyForeignRuns(t *testing.T) {
	_, checkout := testLoadEnv(t)
	foreign := t.TempDir()
	writeSucceededRun(t, foreign, "there", "")

	state := Load(checkout, ScopeCurrent, "", "")
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
