package assets

import (
	"regexp"
	"testing"
)

func TestManifestVersion(t *testing.T) {
	got := ManifestVersion()
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(got) {
		t.Fatalf("ManifestVersion() = %q, want a semver from the embedded manifest", got)
	}
}
