package contract_test

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"testing"
)

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}

func TestPreflightScriptMustNotExist(t *testing.T) {
	path := filepath.Join(repoRoot(t), "scripts", "preflight.sh")
	if _, err := os.Stat(path); err == nil {
		t.Fatalf("scripts/preflight.sh must not exist (dead install path; go.mod is the Go floor): %s", path)
	} else if !os.IsNotExist(err) {
		t.Fatalf("stat preflight.sh: %v", err)
	}
}

func TestGoModDeclaresGo127(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(repoRoot(t), "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`(?m)^go 1\.27\.0$`).Match(raw) {
		t.Fatalf("go.mod must declare go 1.27.0:\n%s", raw)
	}
}
