package credentials

import (
	"os"
	"path/filepath"
	"testing"
)

// Fixtures in testdata/ are endpoint-record and session.lock samples.
// Mode is 0600. Secrets are redacted to zero UUIDs.
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
