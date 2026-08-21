package assets

import (
	"os"
	"regexp"
	"testing"
)

func TestEmbeddedManifestMatchesRoot(t *testing.T) {
	assertCopy(t, "herdr-plugin.toml", "../herdr-plugin.toml")
}

func TestEmbeddedWorkbenchBundleMatchesSource(t *testing.T) {
	assertCopy(t, "logo.svg", "../docs/assets/logo.svg")
	assertCopy(t, "workflow.schema.json", "../docs/workflow.schema.json")
}

func TestEmbeddedSkillsMatchSource(t *testing.T) {
	copies := []struct{ embedded, source string }{
		{"skills/herdr-workflow-create/SKILL.md", "../skills/herdr-workflow-create/SKILL.md"},
		{"skills/herdr-workflow-create/reference/herdr-api.md", "../skills/herdr-workflow-create/reference/herdr-api.md"},
		{"skills/herdr-workflow-create/reference/recipes.md", "../skills/herdr-workflow-create/reference/recipes.md"},
		{"skills/herdr-workflow-create/reference/syntax.md", "../skills/herdr-workflow-create/reference/syntax.md"},
		{"skills/herdr-workflow-create/scripts/validate.sh", "../skills/herdr-workflow-create/scripts/validate.sh"},
		{"skills/herdr-workflow-upgrade/SKILL.md", "../skills/herdr-workflow-upgrade/SKILL.md"},
		{"skills/herdr-workflow-upgrade/reference/herdr-0.8.0.md", "../skills/herdr-workflow-upgrade/reference/herdr-0.8.0.md"},
	}
	for _, copy := range copies {
		assertCopy(t, copy.embedded, copy.source)
	}
}

func TestManifestVersion(t *testing.T) {
	got := ManifestVersion()
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(got) {
		t.Fatalf("ManifestVersion() = %q, want a semver from the embedded manifest", got)
	}
}

func assertCopy(t *testing.T, embedded, source string) {
	t.Helper()
	want, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(embedded)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("%s drifted from %s; re-copy it", embedded, source)
	}
}
