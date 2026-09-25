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

func TestParseWorkflowTextRejectsPaneOpenTemplates(t *testing.T) {
	step := func(input, pane string) string {
		return "version: v1alpha1\ninputs:\n" + input + "steps:\n  - agent: hi\n    pane: " + pane + "\n"
	}
	const places = "  place: {type: choice, options: [tab, beside]}\n"
	for _, test := range []struct {
		name, text, want string
	}{
		{"step result", "version: v1alpha1\nsteps:\n  - id: a\n    run: \"true\"\n  - agent: hi\n    pane: {open: '{{steps.a.stdout}}'}\n", "pane.open must reference an unconditional closed static choice input"},
		{"conditional input", step("  mode: [a, b]\n  place: {type: choice, options: [tab], when: '{{inputs.mode}} == \"a\"'}\n", "{open: '{{inputs.place}}'}"), "pane.open input 'place' must be unconditional"},
		{"open choice", step("  place: {type: choice, options: [tab], allow_custom: true}\n", "{open: '{{inputs.place}}'}"), "pane.open input 'place' must be a closed static choice"},
		{"text input", step("  place: text\n", "{open: '{{inputs.place}}'}"), "pane.open input 'place' must be a closed static choice"},
		{"dynamic choice", step("  place: {type: choice, options: {run: [echo, tab]}}\n", "{open: '{{inputs.place}}'}"), "pane.open input 'place' must be a closed static choice"},
		{"bad option", step("  place: [tab, left]\n", "{open: '{{inputs.place}}'}"), "pane.open input 'place' options must be tab, beside, or below"},
		{"tab size", step(places, "{open: '{{inputs.place}}', size: 40}"), "pane.target/size are invalid when pane.open can resolve to tab"},
		{"split workspace", step(places, "{open: '{{inputs.place}}', workspace: main}"), "pane.workspace is invalid when pane.open can resolve to beside/below"},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := ParseWorkflowText("pane", test.text, config.Config{}, t.TempDir())
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("got %v, want %q", err, test.want)
			}
		})
	}
}
