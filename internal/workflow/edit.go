package workflow

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const newWorkflowStub = `version: v1alpha1
steps:
  - run: [echo, "edit me"]
`

// EditOpts configures editor handoff plus loader validation.
type EditOpts struct {
	Path     string
	Name     string
	RepoRoot string
	Getenv   func(string) string
	Run      func(argv []string) error
}

// ResolveEditor returns $EDITOR, then $VISUAL.
func ResolveEditor(getenv func(string) string) (string, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	for _, key := range []string{"EDITOR", "VISUAL"} {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v, nil
		}
	}
	return "", fmt.Errorf("set EDITOR or VISUAL to edit workflows")
}

// NewWorkflowStubBody returns a loadable stub with the pinned schema pointer.
func NewWorkflowStubBody() string {
	return WithPinnedSchemaPointer(newWorkflowStub)
}

// CreateRepoWorkflow writes a new stub under repoRoot/.hwf/workflows/<name>.yaml.
func CreateRepoWorkflow(repoRoot, name string) (string, error) {
	if !NameRE.MatchString(name) {
		return "", fmt.Errorf("%s", NameRule)
	}
	dir := filepath.Join(repoRoot, ".hwf", "workflows")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, name+".yaml")
	if _, err := os.Stat(path); err == nil {
		return "", fmt.Errorf("workflow %q already exists", name)
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.WriteFile(path, []byte(NewWorkflowStubBody()), 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// EditAndValidate opens path in the resolved editor, then validates with the loader.
func EditAndValidate(opts EditOpts) ValidateResult {
	getenv := opts.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	editor, err := ResolveEditor(getenv)
	if err != nil {
		return ValidateResult{OK: false, Error: err.Error()}
	}
	run := opts.Run
	if run == nil {
		run = func(argv []string) error {
			cmd := exec.Command(argv[0], argv[1:]...)
			cmd.Stdin = os.Stdin
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			return cmd.Run()
		}
	}
	if err := run([]string{editor, opts.Path}); err != nil {
		return ValidateResult{OK: false, Error: err.Error()}
	}
	return ValidateFile(opts.Path, opts.Name, opts.RepoRoot)
}
