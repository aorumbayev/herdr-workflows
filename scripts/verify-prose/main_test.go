package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeMD(t *testing.T, root, rel, content string) {
	t.Helper()
	path := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCheckProseClickFails(t *testing.T) {
	root := t.TempDir()
	writeMD(t, root, "README.md", "Press click to continue.\n")
	code, stdout, _ := Check(root)
	if code != 1 {
		t.Fatalf("expected exit 1, got %d stdout=%q", code, stdout)
	}
	if !strings.Contains(stdout, `"click" → select`) {
		t.Fatalf("unexpected stdout: %q", stdout)
	}
}

func TestCheckProseClickInBackticksPasses(t *testing.T) {
	root := t.TempDir()
	writeMD(t, root, "README.md", "Use the `click` handler.\n")
	code, stdout, _ := Check(root)
	if code != 0 {
		t.Fatalf("expected exit 0, got %d stdout=%q", code, stdout)
	}
}

func TestCheckProseInOrderToFails(t *testing.T) {
	root := t.TempDir()
	writeMD(t, root, "README.md", "Do this in order to finish.\n")
	code, stdout, _ := Check(root)
	if code != 1 {
		t.Fatalf("expected exit 1, got %d stdout=%q", code, stdout)
	}
	if !strings.Contains(stdout, `"in order to" → to`) {
		t.Fatalf("unexpected stdout: %q", stdout)
	}
}

func TestCheckProseClickInFencePasses(t *testing.T) {
	root := t.TempDir()
	writeMD(t, root, "README.md", "```\nclick here\n```\n")
	code, stdout, _ := Check(root)
	if code != 0 {
		t.Fatalf("expected exit 0, got %d stdout=%q", code, stdout)
	}
}

func TestCheckProseCleanSuccessMessage(t *testing.T) {
	root := t.TempDir()
	writeMD(t, root, "README.md", "Select the row.\n")
	writeMD(t, root, "CONTRIBUTING.md", "Sign in to continue.\n")
	code, stdout, _ := Check(root)
	if code != 0 {
		t.Fatalf("expected exit 0, got %d stdout=%q", code, stdout)
	}
	if stdout != "prose: 2 files clean\n" {
		t.Fatalf("unexpected stdout: %q", stdout)
	}
}
