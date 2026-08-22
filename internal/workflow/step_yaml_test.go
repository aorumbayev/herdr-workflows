package workflow

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/config"
)

func handoffDefinition(t *testing.T) Definition {
	t.Helper()
	repoRoot := t.TempDir()
	path := filepath.Join("..", "..", "examples", "handoff.yaml")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	def, err := ParseWorkflowText("handoff", string(body), config.Config{}, repoRoot, path)
	if err != nil {
		t.Fatal(err)
	}
	return *def
}

func TestFormatStepYAMLBrief(t *testing.T) {
	def := handoffDefinition(t)
	got, err := FormatStepYAML(def.Steps[0])
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"id: brief", "agent:", "using:", "pane:", "close: success"} {
		if !strings.Contains(got, want) {
			t.Fatalf("step YAML missing %q:\n%s", want, got)
		}
	}
}

func TestStepYAMLFragments(t *testing.T) {
	def := handoffDefinition(t)
	fragments, err := StepYAMLFragments(def, []string{"brief"})
	if err != nil {
		t.Fatal(err)
	}
	got, ok := fragments["brief"]
	if !ok {
		t.Fatal("missing brief fragment")
	}
	if !strings.Contains(got, "id: brief") {
		t.Fatalf("fragment = %q", got)
	}
}
