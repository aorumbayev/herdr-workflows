// Command sync-embed writes canonical assets into embed/ for go:embed.
// Generated copies stay the same as their sources, byte for byte. A person must not change the copies by hand.
//
//	go run ./scripts/sync-embed
//
// Sources → copies:
//
//	herdr-plugin.toml            → embed/herdr-plugin.toml
//	docs/assets/logo.svg         → embed/logo.svg
//	docs/workflow.schema.json    → embed/workflow.schema.json
//	skills/**                    → embed/skills/**
package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

type copySpec struct {
	src, dst string
}

func embedCopies() []copySpec {
	return []copySpec{
		{"herdr-plugin.toml", filepath.Join("embed", "herdr-plugin.toml")},
		{filepath.Join("docs", "assets", "logo.svg"), filepath.Join("embed", "logo.svg")},
		{filepath.Join("docs", "workflow.schema.json"), filepath.Join("embed", "workflow.schema.json")},
		{filepath.Join("skills", "herdr-workflow-create", "SKILL.md"), filepath.Join("embed", "skills", "herdr-workflow-create", "SKILL.md")},
		{filepath.Join("skills", "herdr-workflow-create", "reference", "herdr-api.md"), filepath.Join("embed", "skills", "herdr-workflow-create", "reference", "herdr-api.md")},
		{filepath.Join("skills", "herdr-workflow-create", "reference", "recipes.md"), filepath.Join("embed", "skills", "herdr-workflow-create", "reference", "recipes.md")},
		{filepath.Join("skills", "herdr-workflow-create", "reference", "syntax.md"), filepath.Join("embed", "skills", "herdr-workflow-create", "reference", "syntax.md")},
		{filepath.Join("skills", "herdr-workflow-create", "scripts", "validate.sh"), filepath.Join("embed", "skills", "herdr-workflow-create", "scripts", "validate.sh")},
		{filepath.Join("skills", "herdr-workflow-upgrade", "SKILL.md"), filepath.Join("embed", "skills", "herdr-workflow-upgrade", "SKILL.md")},
		{filepath.Join("skills", "herdr-workflow-upgrade", "reference", "herdr-0.8.0.md"), filepath.Join("embed", "skills", "herdr-workflow-upgrade", "reference", "herdr-0.8.0.md")},
	}
}

func syncEmbed(root, embedDir string) error {
	for _, c := range embedCopies() {
		src := filepath.Join(root, c.src)
		// When embedDir is not root/embed (tests), write the destination basename path in embedDir.
		rel, err := filepath.Rel("embed", c.dst)
		if err != nil {
			return err
		}
		dst := filepath.Join(embedDir, rel)
		if err := copyFile(src, dst); err != nil {
			return fmt.Errorf("%s → %s: %w", c.src, dst, err)
		}
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer func() { _ = out.Close() }()
	_, err = io.Copy(out, in)
	return err
}

func repoRoot() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for dir := filepath.Clean(wd); ; dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("sync-embed: no go.mod above %s", wd)
		}
	}
}

func main() {
	root, err := repoRoot()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	embedDir := filepath.Join(root, "embed")
	if err := syncEmbed(root, embedDir); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println("sync-embed: wrote embed copies")
}
