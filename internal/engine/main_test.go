package engine

import (
	"os"
	"path/filepath"
	"testing"
)

// TestMain points HERDR_BIN_PATH at a stub that always fails, so a test that
// forgets to stub a CLI call can never drive the developer's live herdr.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "hwf-engine-quarantine")
	if err != nil {
		panic(err)
	}
	stub := filepath.Join(dir, "herdr")
	if err := os.WriteFile(stub, []byte("#!/bin/sh\necho 'quarantined: real herdr is not available in tests' >&2\nexit 97\n"), 0o755); err != nil {
		panic(err)
	}
	_ = os.Setenv("HERDR_BIN_PATH", stub)
	_ = os.Unsetenv("HERDR_SOCKET_PATH")
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}
