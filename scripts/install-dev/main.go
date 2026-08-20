// Command install-dev builds the working tree, links it as a Herdr plugin, runs
// native setup, and reloads Herdr config. Portable — no shell redirects.
//
// Usage: go run ./scripts/install-dev
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	root, err := repoRoot()
	if err != nil {
		return err
	}
	herdr := os.Getenv("HERDR_BIN_PATH")
	if herdr == "" {
		herdr = "herdr"
	}

	// Unlink fails when no link exists yet, which is the normal first run.
	runCmdIgnoringFailure(root, herdr, []string{"plugin", "unlink", "herdr-workflows"})
	if err := runCmd(root, "build", "go", []string{"build", "-o", "bin/herdr-workflows", "."}); err != nil {
		return err
	}
	if err := runCmd(root, "plugin link", herdr, []string{"plugin", "link", root}); err != nil {
		return err
	}
	binary := filepath.Join(root, "bin", "herdr-workflows")
	if err := runCmd(root, "setup", binary, []string{"setup"}); err != nil {
		return err
	}
	// Reload fails when no Herdr server is running, and the link is already installed.
	runCmdIgnoringFailure(root, herdr, []string{"server", "reload-config"})
	return nil
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
			return "", fmt.Errorf("install-dev: no go.mod above %s", wd)
		}
	}
}

func runCmd(dir, step, name string, args []string) error {
	if err := newCmd(dir, name, args).Run(); err != nil {
		return fmt.Errorf("install-dev: %s failed: %w", step, err)
	}
	return nil
}

func runCmdIgnoringFailure(dir, name string, args []string) {
	_ = newCmd(dir, name, args).Run()
}

func newCmd(dir, name string, args []string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd
}
