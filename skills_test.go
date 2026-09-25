package assets

import (
	"strings"
	"testing"
)

func TestListSkills(t *testing.T) {
	skills := ListSkills()
	if len(skills) != 2 {
		t.Fatalf("len(ListSkills()) = %d, want 2", len(skills))
	}
	if skills[0].Name != "herdr-workflow-create" || skills[1].Name != "herdr-workflow-upgrade" {
		t.Fatalf("names = %q, %q", skills[0].Name, skills[1].Name)
	}
	if skills[0].Description == "" || skills[1].Description == "" {
		t.Fatalf("descriptions must come from frontmatter")
	}
}

func TestFindSkill(t *testing.T) {
	if _, ok := FindSkill("nope"); ok {
		t.Fatal("FindSkill(nope) should be false")
	}
	skill, ok := FindSkill("herdr-workflow-create")
	if !ok || skill.Name != "herdr-workflow-create" {
		t.Fatalf("FindSkill(create) = %#v, %v", skill, ok)
	}
}

func TestFormatSkill(t *testing.T) {
	skill, ok := FindSkill("herdr-workflow-create")
	if !ok {
		t.Fatal("missing create skill")
	}
	got := FormatSkill(skill)
	if !strings.Contains(got, "==> skills/herdr-workflow-create/SKILL.md <==") {
		t.Fatalf("FormatSkill missing header")
	}
	if !strings.HasSuffix(got, "\n") {
		t.Fatalf("FormatSkill must end with newline")
	}
}
