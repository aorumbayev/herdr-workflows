package engine_test

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
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

func TestNoCodeWatchResidue(t *testing.T) {
	src := string(residueSrc(t, "internal/engine/launch.go"))
	for _, name := range []string{"ShouldRetireOnFile", "servedSourceRe", "RetireOnCodeChange", "CodeWatchPath"} {
		if strings.Contains(src, name) {
			t.Fatalf("%s must not exist (watch API deleted until a real watcher lands)", name)
		}
	}
}
