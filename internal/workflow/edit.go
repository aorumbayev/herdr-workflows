package workflow

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/config"
)

const newWorkflowStub = `version: v1alpha1
title: New workflow
description: What this workflow does.
steps:
  - run: [echo, "replace this step"]

# Uncomment and adapt these examples as you build the workflow.
#
# inputs:
#   target:
#     type: text
#     description: A value the workflow collects before it runs.
#
# steps:
#   - agent: Review {{inputs.target}} and report back.
#   - run: [echo, "{{inputs.target}}"]
#     when: "{{context.platform}} == linux"
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
	return createWorkflowStub(filepath.Join(repoRoot, ".hwf", "workflows"), name)
}

// CreateGlobalWorkflow writes a new stub under the global $HOME/.hwf/workflows.
func CreateGlobalWorkflow(name string) (string, error) {
	home, err := config.HomeDir(nil)
	if err != nil {
		return "", err
	}
	return createWorkflowStub(filepath.Join(home, ".hwf", "workflows"), name)
}

func createWorkflowStub(dir, name string) (string, error) {
	if !NameRE.MatchString(name) {
		return "", fmt.Errorf("%s", NameRule)
	}
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
	argv, err := EditorArgv(editor, opts.Path)
	if err != nil {
		return ValidateResult{OK: false, Error: err.Error()}
	}
	if err := run(argv); err != nil {
		return ValidateResult{OK: false, Error: err.Error()}
	}
	return ValidateFile(opts.Path, opts.Name, opts.RepoRoot)
}
