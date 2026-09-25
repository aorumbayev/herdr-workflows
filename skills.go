package assets

import (
	"embed"
	"fmt"
	"regexp"
	"strings"
)

//go:embed skills
var skillsRoot embed.FS

// SkillFile is one embedded file in a bundled skill.
type SkillFile struct {
	Path string
	Text string
}

// Skill is a bundled agent skill and its reference files.
type Skill struct {
	Name        string
	Description string
	Files       []SkillFile
}

var skillCatalog = mustLoadSkillCatalog()

func mustLoadSkillCatalog() []Skill {
	catalog, err := loadSkillCatalog()
	if err != nil {
		panic(err)
	}
	return catalog
}

func loadSkillCatalog() ([]Skill, error) {
	defs := []struct {
		name  string
		paths []string
	}{
		{
			name: "herdr-workflow-create",
			paths: []string{
				"skills/herdr-workflow-create/SKILL.md",
				"skills/herdr-workflow-create/reference/herdr-api.md",
				"skills/herdr-workflow-create/reference/recipes.md",
				"skills/herdr-workflow-create/reference/syntax.md",
				"skills/herdr-workflow-create/scripts/validate.sh",
			},
		},
		{
			name: "herdr-workflow-upgrade",
			paths: []string{
				"skills/herdr-workflow-upgrade/SKILL.md",
				"skills/herdr-workflow-upgrade/reference/herdr-0.8.0.md",
			},
		},
	}
	out := make([]Skill, 0, len(defs))
	for _, def := range defs {
		skill, err := loadSkill(def.name, def.paths)
		if err != nil {
			return nil, err
		}
		out = append(out, skill)
	}
	return out, nil
}

func loadSkill(name string, paths []string) (Skill, error) {
	files := make([]SkillFile, 0, len(paths))
	for _, path := range paths {
		text, err := skillsRoot.ReadFile(path)
		if err != nil {
			return Skill{}, fmt.Errorf("read embedded skill file %s: %w", path, err)
		}
		files = append(files, SkillFile{Path: path, Text: string(text)})
	}
	return Skill{
		Name:        name,
		Description: skillDescription(files[0].Text),
		Files:       files,
	}, nil
}

var skillDescriptionRE = regexp.MustCompile(`(?m)^description:\s*(.+)$`)

func skillDescription(text string) string {
	m := skillDescriptionRE.FindStringSubmatch(text)
	if len(m) < 2 {
		return ""
	}
	return strings.TrimSpace(m[1])
}

// ListSkills returns bundled skills in stable list order.
func ListSkills() []Skill {
	out := make([]Skill, len(skillCatalog))
	copy(out, skillCatalog)
	return out
}

// FindSkill returns one bundled skill by name.
func FindSkill(name string) (Skill, bool) {
	for _, skill := range skillCatalog {
		if skill.Name == name {
			return skill, true
		}
	}
	return Skill{}, false
}

// FormatSkill renders a skill for hwf skills show.
func FormatSkill(skill Skill) string {
	parts := make([]string, len(skill.Files))
	for i, file := range skill.Files {
		parts[i] = fmt.Sprintf("==> %s <==\n\n%s\n", file.Path, strings.TrimRight(file.Text, " \t\r\n"))
	}
	return strings.Join(parts, "\n") + "\n"
}
