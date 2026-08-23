package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeResponseFile(t *testing.T, root, name, body string) string {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestResponseCheckMatchingVerdict(t *testing.T) {
	root := t.TempDir()
	file := writeResponseFile(t, root, "response.txt", "Reasoning about the diff.\n\nAPPROVE\n")
	got := runCLI([]string{"response", "check", file, "--one-of", "APPROVE,REJECT"}, root, nil, "")
	if got.code != 0 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if strings.TrimSpace(got.stdout) != "APPROVE" {
		t.Fatalf("stdout = %q", got.stdout)
	}
	if got.stderr != "" {
		t.Fatalf("stderr = %q", got.stderr)
	}
}

func TestResponseCheckDecoratedVerdictFails(t *testing.T) {
	root := t.TempDir()
	file := writeResponseFile(t, root, "response.txt", "APPROVE — with reservations\n")
	got := runCLI([]string{"response", "check", file, "--one-of", "APPROVE,REJECT"}, root, nil, "")
	if got.code != 1 {
		t.Fatalf("code = %d", got.code)
	}
	if got.stdout != "" {
		t.Fatalf("stdout = %q", got.stdout)
	}
	if !strings.Contains(got.stderr, "APPROVE — with reservations") {
		t.Fatalf("stderr = %q", got.stderr)
	}
	if !strings.Contains(got.stderr, "APPROVE, REJECT") {
		t.Fatalf("stderr = %q", got.stderr)
	}
}

func TestResponseCheckMissingOrEmptyFile(t *testing.T) {
	root := t.TempDir()
	emptyFile := writeResponseFile(t, root, "response.txt", "   \n\n")
	empty := runCLI([]string{"response", "check", emptyFile, "--one-of", "APPROVE"}, root, nil, "")
	if empty.code != 1 || !strings.Contains(empty.stderr, emptyFile) {
		t.Fatalf("empty file: code=%d stderr=%q", empty.code, empty.stderr)
	}

	gone := filepath.Join(root, "nope.txt")
	missing := runCLI([]string{"response", "check", gone, "--one-of", "APPROVE"}, root, nil, "")
	if missing.code != 1 || !strings.Contains(missing.stderr, gone) {
		t.Fatalf("missing file: code=%d stderr=%q", missing.code, missing.stderr)
	}
}

func TestResponseCheckBadTokenLists(t *testing.T) {
	root := t.TempDir()
	file := writeResponseFile(t, root, "response.txt", "APPROVE\n")

	lower := runCLI([]string{"response", "check", file, "--one-of", "approve"}, root, nil, "")
	if lower.code != 1 || !strings.Contains(lower.stderr, "[A-Z][A-Z0-9_]{0,31}") {
		t.Fatalf("lower: code=%d stderr=%q", lower.code, lower.stderr)
	}

	dup := runCLI([]string{"response", "check", file, "--one-of", "APPROVE,APPROVE"}, root, nil, "")
	if dup.code != 1 || !strings.Contains(dup.stderr, "duplicate verdict token 'APPROVE'") {
		t.Fatalf("dup: code=%d stderr=%q", dup.code, dup.stderr)
	}

	blank := runCLI([]string{"response", "check", file, "--one-of", " , "}, root, nil, "")
	if blank.code != 1 || !strings.Contains(blank.stderr, "at least one verdict token") {
		t.Fatalf("blank: code=%d stderr=%q", blank.code, blank.stderr)
	}

	noFlag := runCLI([]string{"response", "check", file}, root, nil, "")
	if noFlag.code == 0 || !strings.Contains(noFlag.stderr, "one-of") {
		t.Fatalf("no flag: code=%d stderr=%q", noFlag.code, noFlag.stderr)
	}
}

func TestResponseCheckOffline(t *testing.T) {
	root := t.TempDir()
	file := writeResponseFile(t, root, "response.txt", "APPROVE\n")
	got := runCLI([]string{"response", "check", file, "--one-of", "APPROVE"}, root, map[string]string{
		"HERDR_SOCKET_PATH": filepath.Join(root, "missing.sock"),
	}, "")
	if got.code != 0 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if strings.TrimSpace(got.stdout) != "APPROVE" {
		t.Fatalf("stdout = %q", got.stdout)
	}
}
