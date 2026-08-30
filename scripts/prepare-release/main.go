// Command prepare-release writes the next plugin version into herdr-plugin.toml.
// For the default manifest path, it writes docs/workflow.schema.json again so that $id
// equals the release tag.
//
// Usage: go run ./scripts/prepare-release <x.y.z> [tomlPath]
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"

	"github.com/aorumbayev/herdr-workflows/scripts/internal/reporoot"
)

var versionRE = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 || !versionRE.MatchString(args[0]) {
		return fmt.Errorf("prepare-release: expected x.y.z version, got %q", argOrNull(args))
	}
	version := args[0]

	root, err := reporoot.Find()
	if err != nil {
		return err
	}
	defaultToml := filepath.Join(root, "herdr-plugin.toml")
	target := defaultToml
	if len(args) >= 2 {
		target = args[1]
	}

	text, err := os.ReadFile(target)
	if err != nil {
		return err
	}
	if !regexp.MustCompile(`(?m)^version\s*=\s*"[^"]+"`).Match(text) {
		return fmt.Errorf("prepare-release: herdr-plugin.toml has no version field")
	}
	next := regexp.MustCompile(`(?m)^version\s*=\s*"[^"]+"`).ReplaceAllString(string(text), `version = "`+version+`"`)
	if err := os.WriteFile(target, []byte(next), 0o644); err != nil {
		return err
	}
	fmt.Printf("prepare-release: %s → %s\n", target, version)

	if target != defaultToml {
		return nil
	}

	sync := exec.Command("go", "run", "./scripts/sync-embed")
	sync.Dir = root
	sync.Stdout = os.Stdout
	sync.Stderr = os.Stderr
	if err := sync.Run(); err != nil {
		return err
	}

	cmd := exec.Command("go", "run", "./scripts/generate-workflow-schema")
	cmd.Dir = root
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return err
	}
	fmt.Println("prepare-release: regenerated docs/workflow.schema.json")
	return nil
}

func argOrNull(args []string) any {
	if len(args) == 0 {
		return nil
	}
	return args[0]
}
