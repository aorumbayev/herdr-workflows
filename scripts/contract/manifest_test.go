package contract_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestManifestBuildDownloadsVerifiedArchive(t *testing.T) {
	root := repoRoot(t)
	data, err := os.ReadFile(filepath.Join(root, "herdr-plugin.toml"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	flat := strings.Join(strings.Fields(text), " ")

	for _, want := range []string{
		"scripts/install-release.sh",
		"bin/herdr-workflows",
		"setup",
		"width = 64",
		"height = 15",
	} {
		if !strings.Contains(flat, want) {
			t.Fatalf("herdr-plugin.toml missing %q", want)
		}
	}
	for _, forbidden := range []string{
		"go build",
		"scripts/preflight.sh",
		"bun install",
		"bun build",
		"src/cli.ts",
	} {
		if strings.Contains(flat, forbidden) {
			t.Fatalf("herdr-plugin.toml must not contain %q", forbidden)
		}
	}
}
