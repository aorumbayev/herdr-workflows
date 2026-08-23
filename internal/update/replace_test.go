package update

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReplaceExecutableAtomic(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "herdr-workflows")
	if err := os.WriteFile(dest, []byte("old-binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(dir, "new-binary")
	if err := os.WriteFile(src, []byte("new-binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := ReplaceExecutable(src, dest); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new-binary" {
		t.Fatalf("dest = %q", got)
	}
}

func TestReplaceExecutableLeavesDestWhenSourceMissing(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "herdr-workflows")
	if err := os.WriteFile(dest, []byte("old-binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	err := ReplaceExecutable(filepath.Join(dir, "missing"), dest)
	if err == nil {
		t.Fatal("expected error")
	}
	got, readErr := os.ReadFile(dest)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(got) != "old-binary" {
		t.Fatalf("dest overwritten: %q", got)
	}
}
