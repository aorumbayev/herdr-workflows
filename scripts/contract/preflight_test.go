package contract_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
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

func preflightScript(t *testing.T) string {
	t.Helper()
	return filepath.Join(repoRoot(t), "scripts", "preflight.sh")
}

func runPreflight(t *testing.T, env []string) (code int, stderr string) {
	t.Helper()
	cmd := exec.Command("sh", preflightScript(t))
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			return exit.ExitCode(), string(out)
		}
		t.Fatalf("run preflight: %v", err)
	}
	return 0, string(out)
}

func TestPreflightPassesWithHostGo(t *testing.T) {
	code, stderr := runPreflight(t, os.Environ())
	if code != 0 {
		t.Fatalf("code = %d stderr = %q", code, stderr)
	}
	if stderr != "" {
		t.Fatalf("stderr = %q, want empty", stderr)
	}
}

func TestPreflightFailsWhenGoAbsent(t *testing.T) {
	dir := t.TempDir()
	env := append([]string{}, os.Environ()...)
	env = append(env, "PATH="+dir)
	code, stderr := runPreflight(t, env)
	if code == 0 {
		t.Fatal("expected non-zero exit")
	}
	if !regexp.MustCompile(`requires Go >= 1\.25`).MatchString(stderr) {
		t.Fatalf("stderr = %q", stderr)
	}
	if !strings.Contains(stderr, "not found") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestPreflightFailsWhenGoTooOld(t *testing.T) {
	dir := t.TempDir()
	fakeGo := filepath.Join(dir, "go")
	if err := os.WriteFile(fakeGo, []byte("#!/bin/sh\necho go version go1.24.0 darwin/arm64\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	env := append([]string{}, os.Environ()...)
	env = append(env, "PATH="+dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	code, stderr := runPreflight(t, env)
	if code == 0 {
		t.Fatal("expected non-zero exit")
	}
	if !regexp.MustCompile(`requires Go >= 1\.25`).MatchString(stderr) {
		t.Fatalf("stderr = %q", stderr)
	}
	if !regexp.MustCompile(`found 1\.24`).MatchString(stderr) {
		t.Fatalf("stderr = %q", stderr)
	}
}
