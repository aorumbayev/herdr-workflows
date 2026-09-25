package cli

import (
	"os"
	"path/filepath"
	"testing"
)

const childEnv = "HWF_CLI_TEST_CHILD"

// TestMain runs the test binary as hwf when a test spawned it as a detached child,
// and points herdr at a failing stub so no test reaches a real herdr.
func TestMain(m *testing.M) {
	if os.Getenv(childEnv) == "1" {
		os.Exit(Main(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
	}
	dir, err := os.MkdirTemp("", "hwf-cli-quarantine")
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
