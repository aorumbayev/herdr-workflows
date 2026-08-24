package engine

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/host"
)

func TestCoordinationError(t *testing.T) {
	outcome := DispatchFailure("agent", &host.HerdrError{Code: "closed", Msg: "socket closed"})
	want := "agent: herdr coordination was lost (socket closed) — the action may still be active; panes were preserved and on_failure was skipped"
	if outcome.Error != want {
		t.Fatalf("got %q, want %q", outcome.Error, want)
	}
}

func TestIsCoordinationError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "transport loss code closed",
			err:  &host.HerdrError{Code: "closed", Msg: "pane.split: socket closed"},
			want: true,
		},
		{
			name: "transport loss code no_socket",
			err:  &host.HerdrError{Code: "no_socket", Msg: "HERDR_SOCKET_PATH is not set"},
			want: true,
		},
		{
			name: "transport loss code unreachable",
			err:  &host.HerdrError{Code: "unreachable", Msg: "unreachable herdr at /tmp/x: pane.split: closed"},
			want: true,
		},
		{
			name: "non-transport HerdrError",
			err:  &host.HerdrError{Code: "invalid_params", Msg: "bad ratio"},
			want: false,
		},
		{
			name: "generic error",
			err:  &host.HerdrError{Code: "internal", Msg: "plain Error wrapped"},
			want: false,
		},
		{
			name: "non-error type",
			err:  nil,
			want: false,
		},
		{
			name: "plain error read ECONNRESET",
			err:  errors.New("read ECONNRESET"),
			want: false,
		},
		{
			name: "plain error write EPIPE",
			err:  errors.New("write EPIPE"),
			want: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := IsCoordinationError(tc.err)
			if got != tc.want {
				t.Fatalf("IsCoordinationError(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

func TestReadTruncated(t *testing.T) {
	cases := []struct {
		name   string
		result any
		want   bool
	}{
		{
			name:   "read.truncated is true",
			result: map[string]any{"read": map[string]any{"truncated": true}},
			want:   true,
		},
		{
			name:   "read.truncated is false",
			result: map[string]any{"read": map[string]any{"truncated": false}},
			want:   false,
		},
		{
			name:   "missing read key",
			result: map[string]any{},
			want:   false,
		},
		{
			name:   "missing truncated key",
			result: map[string]any{"read": map[string]any{}},
			want:   false,
		},
		{
			name:   "nil result",
			result: nil,
			want:   false,
		},
		{
			name:   "read is not a map",
			result: map[string]any{"read": "not a map"},
			want:   false,
		},
		{
			name:   "truncated is non-bool truthy value",
			result: map[string]any{"read": map[string]any{"truncated": "truthy"}},
			want:   false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ReadTruncated(tc.result)
			if got != tc.want {
				t.Fatalf("ReadTruncated(%+v) = %v, want %v", tc.result, got, tc.want)
			}
		})
	}
}

func TestDispatchFailure(t *testing.T) {
	t.Run("transport loss becomes coordination lost outcome", func(t *testing.T) {
		err := &host.HerdrError{Code: "closed", Msg: "socket closed"}
		outcome := DispatchFailure("herdr pane.split", err)

		if outcome.OK {
			t.Fatal("expected OK=false")
		}

		if !outcome.CoordinationLost {
			t.Fatal("expected CoordinationLost=true")
		}

		if !strings.Contains(outcome.Error, "may still be active") {
			t.Fatalf("expected error message to contain 'may still be active', got %q", outcome.Error)
		}
	})

	t.Run("plain error becomes action error", func(t *testing.T) {
		err := errors.New("something failed")
		outcome := DispatchFailure("some action", err)

		if outcome.OK {
			t.Fatal("expected OK=false")
		}

		if outcome.CoordinationLost {
			t.Fatal("expected CoordinationLost=false")
		}

		if !strings.Contains(outcome.Error, "some action") {
			t.Fatalf("expected error message to contain action name, got %q", outcome.Error)
		}

		if !strings.Contains(outcome.Error, "something failed") {
			t.Fatalf("expected error message to contain error text, got %q", outcome.Error)
		}
	})
}

func TestRunScratchDir(t *testing.T) {
	repoRoot := "/my/repo"
	expected := filepath.Join(repoRoot, ".hwf", "tmp")
	got := RunScratchDir(repoRoot)

	if got != expected {
		t.Fatalf("RunScratchDir(%q) = %q, want %q", repoRoot, got, expected)
	}
}

func TestEnsureRunScratchDir(t *testing.T) {
	t.Run("creates directory with 0700 mode", func(t *testing.T) {
		tmpbase := t.TempDir()
		repoRoot := filepath.Join(tmpbase, "repo")

		dir, err := EnsureRunScratchDir(repoRoot, "")
		if err != nil {
			t.Fatalf("EnsureRunScratchDir failed: %v", err)
		}

		expected := filepath.Join(repoRoot, ".hwf", "tmp")
		if dir != expected {
			t.Fatalf("returned dir = %q, want %q", dir, expected)
		}

		// Make sure that the directory exists and that the mode is correct
		info, err := os.Stat(dir)
		if err != nil {
			t.Fatalf("directory does not exist: %v", err)
		}

		if !info.IsDir() {
			t.Fatal("path is not a directory")
		}

		mode := info.Mode().Perm()
		if mode != 0o700 {
			t.Fatalf("directory mode = %o, want 0700", mode)
		}
	})

	t.Run("repairs mode when directory already exists at wrong permissions", func(t *testing.T) {
		tmpbase := t.TempDir()
		repoRoot := filepath.Join(tmpbase, "repo")
		dir := filepath.Join(repoRoot, ".hwf", "tmp")

		// Create the directory with wrong permissions
		err := os.MkdirAll(dir, 0o755)
		if err != nil {
			t.Fatalf("setup failed: %v", err)
		}

		// Call EnsureRunScratchDir to repair the mode
		result, err := EnsureRunScratchDir(repoRoot, dir)
		if err != nil {
			t.Fatalf("EnsureRunScratchDir failed: %v", err)
		}

		if result != dir {
			t.Fatalf("returned dir = %q, want %q", result, dir)
		}

		// Make sure that the mode is 0700
		info, err := os.Stat(dir)
		if err != nil {
			t.Fatalf("failed to stat directory: %v", err)
		}

		mode := info.Mode().Perm()
		if mode != 0o700 {
			t.Fatalf("directory mode = %o, want 0700", mode)
		}
	})

	t.Run("uses RunScratchDir when dir is empty", func(t *testing.T) {
		tmpbase := t.TempDir()
		repoRoot := filepath.Join(tmpbase, "repo")

		dir, err := EnsureRunScratchDir(repoRoot, "")
		if err != nil {
			t.Fatalf("EnsureRunScratchDir failed: %v", err)
		}

		expected := RunScratchDir(repoRoot)
		if dir != expected {
			t.Fatalf("with empty dir, returned %q, want %q", dir, expected)
		}
	})
}
