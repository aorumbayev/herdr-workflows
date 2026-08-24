package history

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func testWriterEnv(t *testing.T) (stateDir, checkout string, getenv func(string) string) {
	t.Helper()
	stateDir = t.TempDir()
	checkout = t.TempDir()
	if err := os.Chmod(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
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
	snap, err := ReadSnapshot(result.ID, getenv)
	if err != nil || snap == nil {
		t.Fatalf("read err=%v snap=%v", err, snap)
	}
	if snap.CheckoutRoot != canonical {
		t.Fatalf("checkout_root = %q, want %q", snap.CheckoutRoot, canonical)
	}
}

func TestClaimRacedAcrossProcessesYieldsOneWinner(t *testing.T) {
	if os.Getenv("HWF_CLAIM_RACE_STATE") != "" {
		return
	}
	stateDir, _, _ := testWriterEnv(t)
	id := AllocateRunID()
	results := make(chan string, 6)
	var wg sync.WaitGroup
	for range cap(results) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cmd := exec.Command(os.Args[0], "-test.run", "TestClaimRaceWorker")
			cmd.Env = append(os.Environ(), "HWF_CLAIM_RACE_STATE="+stateDir, "HWF_CLAIM_RACE_ID="+id)
			out, err := cmd.CombinedOutput()
			state := "no-output"
			for line := range strings.SplitSeq(string(out), "\n") {
				if after, ok := strings.CutPrefix(line, "claim-state="); ok {
					state = after
				}
			}
			if state == "no-output" {
				t.Errorf("worker produced no verdict: err=%v out=%s", err, out)
			}
			results <- state
		}()
	}
	wg.Wait()
	close(results)
	counts := map[string]int{}
	for state := range results {
		counts[state]++
	}
	if counts["claimed"] != 1 || counts["rejected"] != cap(results)-1 {
		t.Fatalf("racing claims = %v, want one claimed and the rest rejected", counts)
	}
}

func TestClaimRaceWorker(t *testing.T) {
	stateDir := os.Getenv("HWF_CLAIM_RACE_STATE")
	if stateDir == "" {
		t.Skip("driven by TestClaimRacedAcrossProcessesYieldsOneWinner")
	}
	getenv := func(key string) string {
		if key == "HERDR_PLUGIN_STATE_DIR" {
			return stateDir
		}
		return os.Getenv(key)
	}
	w := NewWriter(getenv)
	defer w.Dispose()
	claim := w.Claim(ClaimMeta{ID: os.Getenv("HWF_CLAIM_RACE_ID"), Workflow: "demo", Source: "repo", CheckoutRoot: stateDir})
	fmt.Printf("claim-state=%s\n", claim.State)
}
