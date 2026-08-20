package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeLines(t *testing.T, path string, n int) {
	t.Helper()
	var b strings.Builder
	for i := 1; i <= n; i++ {
		b.WriteString("// line\n")
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCheckWithinLimit(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "internal", "pkg")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeLines(t, filepath.Join(dir, "ok.go"), 2500)
	code, stdout, _ := Check(root)
	if code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
	if stdout != "file-length: Go sources under 2500 lines (*.gen.go exempt)\n" {
		t.Fatalf("unexpected stdout: %q", stdout)
	}
}

func TestCheckOverLimit(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "scripts", "tool")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeLines(t, filepath.Join(dir, "big.go"), 2501)
	code, stdout, _ := Check(root)
	if code != 1 {
		t.Fatalf("expected exit 1, got %d stdout=%q", code, stdout)
	}
	if !strings.Contains(stdout, "scripts/tool/big.go: 2501 lines (max 2500)") {
		t.Fatalf("unexpected stdout: %q", stdout)
	}
	if !strings.Contains(stdout, "\nfile-length: 1 file over 2500 lines\n") {
		t.Fatalf("missing summary: %q", stdout)
	}
}

func TestCheckGenGoExempt(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "internal", "host")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeLines(t, filepath.Join(dir, "table.gen.go"), 2501)
	code, stdout, _ := Check(root)
	if code != 0 {
		t.Fatalf("expected exit 0, got %d stdout=%q", code, stdout)
	}
	if stdout != "file-length: Go sources under 2500 lines (*.gen.go exempt)\n" {
		t.Fatalf("unexpected stdout: %q", stdout)
	}
}

func TestCheckMainGoScanned(t *testing.T) {
	root := t.TempDir()
	writeLines(t, filepath.Join(root, "main.go"), 2501)
	code, stdout, _ := Check(root)
	if code != 1 {
		t.Fatalf("expected exit 1, got %d", code)
	}
	if !strings.Contains(stdout, "main.go: 2501 lines (max 2500)") {
		t.Fatalf("unexpected stdout: %q", stdout)
	}
}
