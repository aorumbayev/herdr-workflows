package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWebRejectsInvalidRouteBeforeServer(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".hwf", "workflows"), 0o755); err != nil {
		t.Fatal(err)
	}
	got := runCLI([]string{"web", "http://evil.example", "--no-open"}, root, testCLIEnv(t, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
	}), "")
	if got.code != 1 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if !strings.Contains(got.stderr, "web route expects") {
		t.Fatalf("stderr = %q", got.stderr)
	}
}

func TestWebRejectsInvalidPortBeforeServer(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".hwf", "workflows"), 0o755); err != nil {
		t.Fatal(err)
	}
	got := runCLI([]string{"web", "--port", "0", "--no-open"}, root, testCLIEnv(t, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
	}), "")
	if got.code != 1 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if !strings.Contains(got.stderr, "--port expects an integer between 1 and 65535") {
		t.Fatalf("stderr = %q", got.stderr)
	}
}

func TestWebRejectsEqualsFormPort(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".hwf", "workflows"), 0o755); err != nil {
		t.Fatal(err)
	}
	got := runCLI([]string{"web", "--port=0", "--no-open"}, root, testCLIEnv(t, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
	}), "")
	if got.code != 1 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if !strings.Contains(got.stderr, "--port expects an integer between 1 and 65535") {
		t.Fatalf("stderr = %q", got.stderr)
	}
}
