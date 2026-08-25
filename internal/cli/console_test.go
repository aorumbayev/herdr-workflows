package cli

import (
	"os"
	"strings"
	"testing"

	assets "github.com/aorumbayev/herdr-workflows/embed"
	"github.com/spf13/cobra"
)

func TestConsoleCommandRegistered(t *testing.T) {
	root := newRoot()
	found := false
	for _, c := range root.Commands() {
		if c.Name() == "console" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("root must register console")
	}
}

func TestConsoleHelpListsPlacementFlag(t *testing.T) {
	got := runCLI([]string{"console", "--help"}, t.TempDir(), nil, "")
	if got.code != 0 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	joined := got.stdout + got.stderr
	if !strings.Contains(joined, "--placement") {
		t.Fatalf("help missing --placement: %q", joined)
	}
	for _, want := range []string{"tab", "beside", "below"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("help missing %q: %q", want, joined)
		}
	}
	_ = assets.ManifestDescription()
}

func TestConsolePlacementFallsBackToInProcessWhenNoPaneHost(t *testing.T) {
	t.Setenv("HERDR_SOCKET_PATH", "")
	t.Setenv("HERDR_PLUGIN_CONFIG_DIR", t.TempDir())
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	dir := t.TempDir()
	prev, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chdir(prev) }()

	restoreTTY := consoleHasTTY
	consoleHasTTY = func(*cobra.Command) bool { return true }
	defer func() { consoleHasTTY = restoreTTY }()

	called := false
	restoreScreen := consoleScreen
	consoleScreen = func(*cobra.Command) error { called = true; return nil }
	defer func() { consoleScreen = restoreScreen }()

	cmd := newConsoleCmd()
	if err := cmd.Flags().Set("placement", "beside"); err != nil {
		t.Fatal(err)
	}
	if err := runConsole(cmd, nil); err != nil {
		t.Fatalf("runConsole = %v", err)
	}
	if !called {
		t.Fatal("expected in-process fallback when the pane host is unavailable")
	}
}

func TestConsolePlacementWithoutTTYDoesNotFallBack(t *testing.T) {
	restoreTTY := consoleHasTTY
	consoleHasTTY = func(*cobra.Command) bool { return false }
	defer func() { consoleHasTTY = restoreTTY }()

	called := false
	restoreScreen := consoleScreen
	consoleScreen = func(*cobra.Command) error { called = true; return nil }
	defer func() { consoleScreen = restoreScreen }()

	got := runCLI([]string{"console", "--placement", "beside"}, t.TempDir(), testCLIEnv(t, nil), "")
	if got.code == 0 {
		t.Fatal("expected nonzero exit without a tty and no pane host")
	}
	if called {
		t.Fatal("must not fall back to the in-process TUI without a tty")
	}
}

func TestConsoleRejectsInvalidPlacement(t *testing.T) {
	got := runCLI([]string{"console", "--placement", "popup"}, t.TempDir(), testCLIEnv(t, nil), "")
	if got.code == 0 {
		t.Fatal("expected nonzero exit for invalid placement")
	}
	if !strings.Contains(got.stderr, "placement must be tab, beside, or below") {
		t.Fatalf("stderr = %q", got.stderr)
	}
}
