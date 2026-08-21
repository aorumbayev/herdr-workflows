package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheckMissingArchiveDir(t *testing.T) {
	root := t.TempDir()
	code, _, stderr := Check(root)
	if code != 0 {
		t.Fatalf("expected exit 0, got %d stderr=%q", code, stderr)
	}
}

func TestCheckEmptyArchiveDir(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "openspec", "changes", "archive"), 0o755); err != nil {
		t.Fatal(err)
	}
	code, _, stderr := Check(root)
	if code != 0 {
		t.Fatalf("expected exit 0, got %d stderr=%q", code, stderr)
	}
}

func TestCheckArchiveWithEntries(t *testing.T) {
	root := t.TempDir()
	archive := filepath.Join(root, "openspec", "changes", "archive")
	if err := os.MkdirAll(archive, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"alpha", "beta"} {
		if err := os.WriteFile(filepath.Join(archive, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	code, _, stderr := Check(root)
	if code != 1 {
		t.Fatalf("expected exit 1, got %d", code)
	}
	if !strings.Contains(stderr, "openspec/changes/archive holds 2 entries: alpha, beta") {
		t.Fatalf("unexpected stderr: %q", stderr)
	}
	if !strings.Contains(stderr, "Main keeps no archived specs — delete the archived contents; the main specs already carry the sync.") {
		t.Fatalf("missing guidance stderr: %q", stderr)
	}
}

func TestCheckSingleEntryUsesEntryNotEntries(t *testing.T) {
	root := t.TempDir()
	archive := filepath.Join(root, "openspec", "changes", "archive")
	if err := os.MkdirAll(archive, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(archive, "only"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, _, stderr := Check(root)
	if code != 1 {
		t.Fatalf("expected exit 1, got %d", code)
	}
	if !strings.Contains(stderr, "openspec/changes/archive holds 1 entry: only") {
		t.Fatalf("unexpected stderr: %q", stderr)
	}
}
