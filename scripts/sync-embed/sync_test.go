package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestSyncEmbedWritesByteIdenticalCopies(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	copies := []struct{ rel, src string }{
		{"herdr-plugin.toml", "herdr-plugin.toml"},
		{"logo.svg", filepath.Join("docs", "assets", "logo.svg")},
		{"workflow.schema.json", filepath.Join("docs", "workflow.schema.json")},
		{"skills/herdr-workflow-create/SKILL.md", filepath.Join("skills", "herdr-workflow-create", "SKILL.md")},
		{"skills/herdr-workflow-create/reference/herdr-api.md", filepath.Join("skills", "herdr-workflow-create", "reference", "herdr-api.md")},
		{"skills/herdr-workflow-create/reference/recipes.md", filepath.Join("skills", "herdr-workflow-create", "reference", "recipes.md")},
		{"skills/herdr-workflow-create/reference/syntax.md", filepath.Join("skills", "herdr-workflow-create", "reference", "syntax.md")},
		{"skills/herdr-workflow-create/scripts/validate.sh", filepath.Join("skills", "herdr-workflow-create", "scripts", "validate.sh")},
		{"skills/herdr-workflow-upgrade/SKILL.md", filepath.Join("skills", "herdr-workflow-upgrade", "SKILL.md")},
		{"skills/herdr-workflow-upgrade/reference/herdr-0.8.0.md", filepath.Join("skills", "herdr-workflow-upgrade", "reference", "herdr-0.8.0.md")},
	}
	for _, c := range copies {
		srcPath := filepath.Join(root, c.src)
		data, err := os.ReadFile(srcPath)
		if err != nil {
			t.Fatal(err)
		}
		dst := filepath.Join(dir, "src", c.src)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dst, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	srcRoot := filepath.Join(dir, "src")
	embedDir := filepath.Join(dir, "embed")
	if err := syncEmbed(srcRoot, embedDir); err != nil {
		t.Fatal(err)
	}
	for _, c := range copies {
		want, err := os.ReadFile(filepath.Join(srcRoot, c.src))
		if err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(filepath.Join(embedDir, c.rel))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("%s not byte-identical to %s", c.rel, c.src)
		}
	}
}
