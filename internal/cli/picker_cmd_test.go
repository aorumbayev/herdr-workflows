package cli

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/host"
)

func TestPickerRejectsProtocolMismatchBeforeUI(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".hwf", "workflows"), 0o755); err != nil {
		t.Fatal(err)
	}
	sockPath := listenPingSocket(t, host.Protocol+1, host.MinHerdrVersion)
	got := runCLI([]string{"picker"}, root, testCLIEnv(t, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
		"HERDR_SOCKET_PATH":         sockPath,
	}), "")
	if got.code != 1 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if !strings.Contains(got.stderr, "herdr protocol mismatch") {
		t.Fatalf("stderr = %q", got.stderr)
	}
	if !strings.Contains(got.stderr, "pinned="+strconv.Itoa(host.Protocol)) {
		t.Fatalf("stderr = %q", got.stderr)
	}
}

func TestPickerRequiresTTYAfterProtocol(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".hwf", "workflows"), 0o755); err != nil {
		t.Fatal(err)
	}
	sockPath := listenPingSocket(t, host.Protocol, host.MinHerdrVersion)
	got := runCLI([]string{"picker"}, root, testCLIEnv(t, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
		"HERDR_SOCKET_PATH":         sockPath,
	}), "")
	if got.code != 1 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if !strings.Contains(got.stderr, "picker requires a tty") {
		t.Fatalf("stderr = %q", got.stderr)
	}
}

// Skipped in TS parity: the Bun preload mock import race has no Go equivalent without
// mocking internal package load order.
