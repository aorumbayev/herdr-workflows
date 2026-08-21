package workflow

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/config"
)

func TestDefinitionIsExecutableAuthoringResult(t *testing.T) {
	root := t.TempDir()
	writeDomainWorkflow(t, root, "child", `version: v1alpha1
inputs:
  base: text
returns:
  findings: "{{steps.review}}"
steps:
  - id: review
    agent: "review {{inputs.base}}"
`)
	writeDomainWorkflow(t, root, "parent", `version: v1alpha1
steps:
  - id: call
    workflow: child
    inputs: {base: repo}
  - run: [echo, "{{steps.call.findings.response}}"]
`)
	var def *Definition
	loaded, err := LoadWorkflow("parent", root, config.Config{
		Profiles:    map[string]config.Profile{},
		Transcripts: map[string]config.TranscriptExtractor{},
	})
	if err != nil {
		t.Fatal(err)
	}
	def = loaded
	if def.Version != Format {
		t.Fatalf("Version = %q, want %s", def.Version, Format)
	}
	if def.Name != "parent" || def.File == "" {
		t.Fatalf("source identity missing: name=%q file=%q", def.Name, def.File)
	}
	if got := def.SourceKind(); got != "repo" {
		t.Fatalf("SourceKind() = %q, want repo", got)
	}
	child := def.Children["child"]
	if child == nil || child.Steps[0].ID != "review" {
		t.Fatalf("child graph not retained: %#v", def.Children)
	}

	if err := os.WriteFile(filepath.Join(root, ".hwf", "workflows", "child.yaml"), []byte(`version: v1alpha1
inputs:
  base: text
returns:
  findings: "{{steps.other}}"
steps:
  - id: other
    agent: "later {{inputs.base}}"
`), 0o644); err != nil {
		t.Fatal(err)
	}
	if child.Steps[0].ID != "review" {
		t.Fatalf("Definition child graph changed after disk edit: %#v", child.Steps)
	}

	reloaded, err := LoadWorkflow("parent", root, config.Config{
		Profiles:    map[string]config.Profile{},
		Transcripts: map[string]config.TranscriptExtractor{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Children["child"].Steps[0].ID != "other" {
		t.Fatalf("new load did not read edited child: %#v", reloaded.Children["child"].Steps)
	}
}

func TestParseWorkflowTextRejectsUnusedInputAndDuplicateIDs(t *testing.T) {
	root := t.TempDir()
	_, err := ParseWorkflowText("unused", `version: v1alpha1
inputs:
  note: text
steps:
  - run: "true"
`, config.Config{}, root)
	if err == nil || !strings.Contains(err.Error(), "unused input") {
		t.Fatalf("got %v, want unused input", err)
	}

	_, err = ParseWorkflowText("dup", `version: v1alpha1
steps:
  - id: a
    run: "true"
  - id: a
    run: "true"
`, config.Config{}, root)
	if err == nil || !strings.Contains(err.Error(), "duplicate step id 'a'") {
		t.Fatalf("got %v, want duplicate step id", err)
	}
}
