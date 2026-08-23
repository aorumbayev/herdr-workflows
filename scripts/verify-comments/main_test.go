package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeGo(t *testing.T, root, rel, content string) {
	t.Helper()
	path := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCheckThreeLineInteriorBlockFails(t *testing.T) {
	root := t.TempDir()
	writeGo(t, root, "internal/x/a.go", `package x

func f() {
	// one
	// two
	// three
}
`)
	code, stdout, _ := Check(root)
	if code != 1 {
		t.Fatalf("expected exit 1, got %d stdout=%q", code, stdout)
	}
	if !strings.Contains(stdout, "internal/x/a.go:") {
		t.Fatalf("unexpected stdout: %q", stdout)
	}
}

func TestCheckTwoLineInteriorBlockPasses(t *testing.T) {
	root := t.TempDir()
	writeGo(t, root, "internal/x/a.go", `package x

func f() {
	// one
	// two
}
`)
	code, stdout, _ := Check(root)
	if code != 0 {
		t.Fatalf("expected exit 0, got %d stdout=%q", code, stdout)
	}
}

func TestCheckGodocExempt(t *testing.T) {
	root := t.TempDir()
	writeGo(t, root, "internal/x/a.go", `package x

// Line one of godoc.
// Line two of godoc.
// Line three of godoc.
// Line four of godoc.
func F() {}
`)
	code, stdout, _ := Check(root)
	if code != 0 {
		t.Fatalf("expected exit 0, got %d stdout=%q", code, stdout)
	}
}

func TestCheckContextBlockExempt(t *testing.T) {
	root := t.TempDir()
	writeGo(t, root, "internal/x/a.go", `package x

func f() {
	// context: durable fact the code cannot express
	// second line
	// third line
}
`)
	code, stdout, _ := Check(root)
	if code != 0 {
		t.Fatalf("expected exit 0, got %d stdout=%q", code, stdout)
	}
}

func TestCheckSuccessMessage(t *testing.T) {
	root := t.TempDir()
	writeGo(t, root, "main.go", "package main\n\nfunc main() {}\n")
	code, stdout, _ := Check(root)
	if code != 0 {
		t.Fatalf("expected exit 0, got %d stdout=%q", code, stdout)
	}
	want := "comments: Go sources clean (godoc and context: exempt; interior blocks ≤2 lines)\n"
	if stdout != want {
		t.Fatalf("unexpected stdout: %q", stdout)
	}
}

func TestCheckGenGoExempt(t *testing.T) {
	root := t.TempDir()
	writeGo(t, root, "internal/host/x.gen.go", `package host

func f() {
	// one
	// two
	// three
}
`)
	code, stdout, _ := Check(root)
	if code != 0 {
		t.Fatalf("expected exit 0, got %d stdout=%q", code, stdout)
	}
}
