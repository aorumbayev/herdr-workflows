package transcript

import (
	"os"
	"path/filepath"
	"testing"
)

// TestMain sets HERDR_BIN_PATH to a stub that always fails. A test that does not
// stub a CLI call cannot operate the live herdr of the developer.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "hwf-transcript-quarantine")
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
