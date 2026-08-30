package workflow

import (
	"fmt"
	"os"
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
