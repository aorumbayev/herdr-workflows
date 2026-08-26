package picker

import (
	"os/exec"

	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func editorCommand(editor, path string) *exec.Cmd {
	argv := workflow.EditorArgv(editor, path)
	return exec.Command(argv[0], argv[1:]...)
}
