package cli

import (
	"strings"
	"testing"
)

func TestSkillsListPrintsBundledDescriptions(t *testing.T) {
	root := t.TempDir()
	got := runCLI([]string{"skills", "list"}, root, nil, "")
	if got.code != 0 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if got.stderr != "" {
		t.Fatalf("stderr = %q", got.stderr)
	}
	lines := strings.Split(strings.TrimSpace(got.stdout), "\n")
	if len(lines) != 2 {
		t.Fatalf("stdout lines = %d, want 2:\n%s", len(lines), got.stdout)
	}
	if !strings.HasPrefix(lines[0], "herdr-workflow-create — ") || len(lines[0]) <= len("herdr-workflow-create — ") {
		t.Fatalf("line 0 = %q", lines[0])
	}
	if !strings.HasPrefix(lines[1], "herdr-workflow-upgrade — ") || len(lines[1]) <= len("herdr-workflow-upgrade — ") {
		t.Fatalf("line 1 = %q", lines[1])
	}
}

func TestSkillsShowCreateSkill(t *testing.T) {
	root := t.TempDir()
	got := runCLI([]string{"skills", "show", "herdr-workflow-create"}, root, nil, "")
	if got.code != 0 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	for _, want := range []string{
		"==> skills/herdr-workflow-create/SKILL.md <==",
		"==> skills/herdr-workflow-create/reference/herdr-api.md <==",
		"==> skills/herdr-workflow-create/reference/recipes.md <==",
		"==> skills/herdr-workflow-create/reference/syntax.md <==",
		"==> skills/herdr-workflow-create/scripts/validate.sh <==",
		"name: herdr-workflow-create",
	} {
		if !strings.Contains(got.stdout, want) {
			t.Fatalf("stdout missing %q", want)
		}
	}
	if strings.Contains(got.stdout, "herdr-workflow-upgrade/SKILL.md") {
		t.Fatalf("stdout must not contain upgrade skill")
	}
}

func TestSkillsShowUpgradeSkill(t *testing.T) {
	root := t.TempDir()
	got := runCLI([]string{"skills", "show", "herdr-workflow-upgrade"}, root, nil, "")
	if got.code != 0 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	for _, want := range []string{
		"==> skills/herdr-workflow-upgrade/SKILL.md <==",
		"==> skills/herdr-workflow-upgrade/reference/herdr-0.8.0.md <==",
		"name: herdr-workflow-upgrade",
	} {
		if !strings.Contains(got.stdout, want) {
			t.Fatalf("stdout missing %q", want)
		}
	}
}

func TestSkillsShowUnknownSkill(t *testing.T) {
	root := t.TempDir()
	got := runCLI([]string{"skills", "show", "nope"}, root, nil, "")
	if got.code != 1 {
		t.Fatalf("code = %d", got.code)
	}
	if got.stdout != "" {
		t.Fatalf("stdout = %q", got.stdout)
	}
	if !strings.Contains(got.stderr, "unknown skill 'nope'") {
		t.Fatalf("stderr = %q", got.stderr)
	}
	if !strings.Contains(got.stderr, "herdr-workflow-create") || !strings.Contains(got.stderr, "herdr-workflow-upgrade") {
		t.Fatalf("stderr = %q", got.stderr)
	}
}
