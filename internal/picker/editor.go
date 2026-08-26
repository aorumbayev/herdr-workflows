package picker

import (
	"os/exec"

	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func editorCommand(editor, path string) (*exec.Cmd, error) {
	argv, err := workflow.EditorArgv(editor, path)
	if err != nil {
		return nil, err
	}
	return exec.Command(argv[0], argv[1:]...), nil
}
