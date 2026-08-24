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

func TestGoModDeclaresGo127(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(repoRoot(t), "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`(?m)^go 1\.27\.0$`).Match(raw) {
		t.Fatalf("go.mod must declare go 1.27.0:\n%s", raw)
	}
}
