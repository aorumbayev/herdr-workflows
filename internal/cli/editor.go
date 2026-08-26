package cli

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/picker"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
	"github.com/spf13/cobra"
)

func newEditorCmd() *cobra.Command {
	return &cobra.Command{
		Use:    "editor",
		Short:  "Open a workflow file in $EDITOR (plugin pane entrypoint)",
		Hidden: true,
		RunE:   runEditor,
	}
}

func runEditor(_ *cobra.Command, _ []string) error {
	path := os.Getenv(picker.EditorFileEnv)
	name := os.Getenv(picker.EditorNameEnv)
	if path == "" {
		return fmt.Errorf("editor requires %s", picker.EditorFileEnv)
	}
	editor, err := workflow.ResolveEditor(os.Getenv)
	if err != nil {
		_ = host.NotificationShow("herdr-workflows", err.Error())
		return err
	}
	argv := workflow.EditorArgv(editor, path)
	proc := exec.Command(argv[0], argv[1:]...)
	proc.Stdin = os.Stdin
	proc.Stdout = os.Stdout
	proc.Stderr = os.Stderr
	if err := proc.Run(); err != nil {
		_ = host.NotificationShow("herdr-workflows", "editor exited: "+err.Error())
		return err
	}
	result := workflow.ValidateFile(path, name, os.Getenv("HERDR_WORKFLOWS_REPO_ROOT"))
	if result.OK {
		_ = host.NotificationShow("herdr-workflows", "validated "+name)
		return nil
	}
	_ = host.NotificationShow("herdr-workflows", "validate failed: "+result.Error)
	return nil
}
