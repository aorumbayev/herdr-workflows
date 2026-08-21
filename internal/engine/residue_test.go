package engine_test

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"testing"
)

func residueSrc(t *testing.T, rel string) []byte {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
	raw, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestNoShouldRetireOnFileResidue(t *testing.T) {
	src := residueSrc(t, "internal/engine/launch.go")
	if regexp.MustCompile(`\bShouldRetireOnFile\b`).Match(src) {
		t.Fatal("ShouldRetireOnFile must not exist (tests-only; RetireOnCodeChange never filters paths)")
	}
	if regexp.MustCompile(`\bservedSourceRe\b`).Match(src) {
		t.Fatal("servedSourceRe must not exist after ShouldRetireOnFile deletion")
	}
}
