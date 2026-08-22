package cli

import (
	"strings"
	"testing"

	assets "github.com/aorumbayev/herdr-workflows/embed"
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

func TestConsoleRejectsInvalidPlacement(t *testing.T) {
	got := runCLI([]string{"console", "--placement", "popup"}, t.TempDir(), testCLIEnv(t, nil), "")
	if got.code == 0 {
		t.Fatal("expected nonzero exit for invalid placement")
	}
	if !strings.Contains(got.stderr, "placement must be tab, beside, or below") {
		t.Fatalf("stderr = %q", got.stderr)
	}
}
