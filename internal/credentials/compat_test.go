package credentials

import (
	"os"
	"path/filepath"
	"testing"
)

// The fixtures are copies of real TS-written credential-store files
// (~/.hwf/state/web-endpoints/): an endpoint record and a session lock, both
// written 0600 by the TS writer. Secrets (URL token, session id) are
// redacted to zero UUIDs; structure and lengths are unchanged.
func TestRealInstallCredentialFilesPassPrivacyChecks(t *testing.T) {
	store := t.TempDir()
	if err := AssertCredentialStoreSafe(store, nil); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"endpoint-record.json", "session.lock"} {
		data, err := os.ReadFile(filepath.Join("testdata", name))
		if err != nil {
			t.Fatal(err)
		}
		dst := filepath.Join(store, name)
		if err := os.WriteFile(dst, data, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := AssertPrivateCredentialFile(dst, nil); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		info, err := os.Stat(dst)
		if err != nil {
			t.Fatal(err)
		}
		if mode := info.Mode() & 0o777; mode != 0o600 {
			t.Fatalf("%s mode = %o, want 600", name, mode)
		}
	}
}
