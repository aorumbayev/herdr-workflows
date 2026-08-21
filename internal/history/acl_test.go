package history

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/credentials"
)

func TestEmptyPermissiveStateRootIsTightenedAndClaimable(t *testing.T) {
	// Ports test/history/history-store.test.ts "empty permissive state root is tightened and claimable".
	if runtime.GOOS == "windows" {
		t.Skip("posix modes")
	}
	stateDir := t.TempDir()
	checkout := t.TempDir()
	if err := os.Chmod(stateDir, 0o755); err != nil {
		t.Fatal(err)
	}
	getenv := func(key string) string {
		if key == "HERDR_PLUGIN_STATE_DIR" {
			return stateDir
		}
		return os.Getenv(key)
	}
	w := NewWriter(getenv)
	defer w.Dispose()
	result := w.Claim(ClaimMeta{Workflow: "demo", Source: "repo", CheckoutRoot: checkout})
	if !result.OK || result.State != "claimed" {
		t.Fatalf("claim = %+v", result)
	}
	info, err := os.Stat(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&0o777 != 0o700 {
		t.Fatalf("mode = %o", info.Mode()&0o777)
	}
}

func TestNonEmptyPermissiveStateRootMakesHistoryUnavailable(t *testing.T) {
	// Ports test/history/history-store.test.ts "non-empty permissive state root makes history unavailable".
	if runtime.GOOS == "windows" {
		t.Skip("posix modes")
	}
	stateDir := t.TempDir()
	checkout := t.TempDir()
	if err := os.WriteFile(filepath.Join(stateDir, "marker"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(stateDir, 0o755); err != nil {
		t.Fatal(err)
	}
	getenv := func(key string) string {
		if key == "HERDR_PLUGIN_STATE_DIR" {
			return stateDir
		}
		return os.Getenv(key)
	}
	w := NewWriter(getenv)
	defer w.Dispose()
	result := w.Claim(ClaimMeta{Workflow: "demo", Source: "repo", CheckoutRoot: checkout})
	if !result.OK || result.State != "unavailable" {
		t.Fatalf("claim = %+v", result)
	}
	info, err := os.Stat(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&0o777 != 0o755 {
		t.Fatalf("mode changed to %o", info.Mode()&0o777)
	}
}

func TestHistoryACLRefusesForeignGrantsWithoutStripping(t *testing.T) {
	// Ports test/history/history-store.test.ts "history ACL validation refuses foreign grants without stripping".
	dir := t.TempDir()
	target := filepath.Join(dir, "inner")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	opts := historyACLOpts()
	opts.Chmod = func(string, os.FileMode) error { return nil }
	opts.StripACL = func(string) {}
	opts.ReadACL = func(string) []credentials.ACLGrant {
		return []credentials.ACLGrant{{Principal: "user:other", Allow: true}}
	}
	err := credentials.AssertCredentialStoreSafe(target, opts)
	if err == nil || !strings.Contains(err.Error(), "foreign ACL") {
		t.Fatalf("err = %v", err)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&0o777 != 0o700 {
		t.Fatalf("mode = %o", info.Mode()&0o777)
	}
}
