// Command install-dev compiles the working tree, connects it as a Herdr plugin, operates
// native setup, and reloads Herdr config. The command is portable. It does not use shell redirects.
//
// Usage: go run ./scripts/install-dev
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/aorumbayev/herdr-workflows/scripts/internal/reporoot"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	root, err := reporoot.Find()
	if err != nil {
		return err
	}
	herdr := os.Getenv("HERDR_BIN_PATH")
	if herdr == "" {
		herdr = "herdr"
	}

	// Unlink fails when no link is there yet. That result is the usual first operation.
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
	// Reload fails when no Herdr server operates. The link is already installed.
	runCmdIgnoringFailure(root, herdr, []string{"server", "reload-config"})
	return nil
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
