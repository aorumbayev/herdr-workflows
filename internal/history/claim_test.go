package history

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func testWriterEnv(t *testing.T) (stateDir, checkout string, getenv func(string) string) {
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

func TestClaimRejectsReusedIdentity(t *testing.T) {
	// Ports test/history/history-store.test.ts "exclusive claims reject reused identity".
	_, checkout, getenv := testWriterEnv(t)
	id := AllocateRunID()
	a := NewWriter(getenv)
	b := NewWriter(getenv)
	defer a.Dispose()
	defer b.Dispose()
	first := a.Claim(ClaimMeta{ID: id, Workflow: "demo", Source: "repo", CheckoutRoot: checkout})
	if !first.OK || first.State != "claimed" || first.ID != id {
		t.Fatalf("first claim = %+v", first)
	}
	second := b.Claim(ClaimMeta{ID: id, Workflow: "demo", Source: "repo", CheckoutRoot: checkout})
	if second.OK || second.State != "rejected" || second.ID != id {
		t.Fatalf("second claim = %+v", second)
	}
}

func TestConcurrentClaimsOwnDifferentSnapshots(t *testing.T) {
	// Ports test/history/history-store.test.ts "concurrent runs own different snapshots".
	_, checkout, getenv := testWriterEnv(t)
	a := NewWriter(getenv)
	b := NewWriter(getenv)
	defer a.Dispose()
	defer b.Dispose()
	first := a.Claim(ClaimMeta{Workflow: "demo", Source: "repo", CheckoutRoot: checkout})
	second := b.Claim(ClaimMeta{Workflow: "demo", Source: "repo", CheckoutRoot: checkout})
	if first.State != "claimed" || second.State != "claimed" {
		t.Fatalf("claims = %+v %+v", first, second)
	}
	if a.ID() == "" || a.ID() == b.ID() {
		t.Fatalf("ids %q and %q must differ", a.ID(), b.ID())
	}
}

func TestUnresolvableClaimCheckoutIsUnavailable(t *testing.T) {
	// Ports test/history/history-store.test.ts "unresolvable claim checkout is unavailable".
	_, _, getenv := testWriterEnv(t)
	w := NewWriter(getenv)
	defer w.Dispose()
	missing := filepath.Join(t.TempDir(), "missing-checkout")
	result := w.Claim(ClaimMeta{Workflow: "demo", Source: "repo", CheckoutRoot: missing})
	if !result.OK || result.State != "unavailable" {
		t.Fatalf("claim = %+v", result)
	}
}

func TestClaimStoresRealpathCanonicalRoot(t *testing.T) {
	// Ports the writer half of "checkout root is realpath-canonicalized".
	_, checkout, getenv := testWriterEnv(t)
	canonical, err := filepath.EvalSymlinks(checkout)
	if err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(checkout, link); err != nil {
		t.Fatal(err)
	}
	w := NewWriter(getenv)
	defer w.Dispose()
	result := w.Claim(ClaimMeta{Workflow: "demo", Source: "repo", CheckoutRoot: link})
	if result.State != "claimed" {
		t.Fatalf("claim = %+v", result)
	}
	raw, err := os.ReadFile(SnapshotPath(result.ID, getenv))
	if err != nil {
		t.Fatal(err)
	}
	var snap map[string]any
	if err := json.Unmarshal(raw, &snap); err != nil {
		t.Fatal(err)
	}
	got, _ := snap["checkout_root"].(string)
	if got != canonical {
		t.Fatalf("checkout_root = %q, want %q", got, canonical)
	}
}
