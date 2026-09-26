package workflow

import (
	"maps"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/config"
)

func TestActiveInputsKeepsOnlyInputsActiveUnderTheRecordedAnswers(t *testing.T) {
	root := t.TempDir()
	writeDomainWorkflow(t, root, "m", `version: v1alpha1
inputs:
  mode: [create, delete]
  name:
    type: text
    when: '{{inputs.mode}} == "create"'
  branch:
    type: choice
    options:
      run: [echo, main]
    when: '{{inputs.mode}} == "create"'
steps:
  - run: [echo, "{{inputs.mode}}"]
  - run: [echo, "{{inputs.name}}", "{{inputs.branch}}"]
    when: '{{inputs.mode}} == "create"'
`)
	def, err := LoadWorkflow("m", root, config.Config{})
	if err != nil {
		t.Fatal(err)
	}
	values := map[string]string{"mode": "delete", "name": "x", "branch": "main", "gone": "y"}
	domains := map[string][]string{"branch": {"main"}}
	gotValues, gotDomains := ActiveInputs(def, values, domains)
	if !maps.Equal(gotValues, map[string]string{"mode": "delete"}) || len(gotDomains) != 0 {
		t.Fatalf("delete: values = %v domains = %v", gotValues, gotDomains)
	}
	values["mode"] = "create"
	gotValues, gotDomains = ActiveInputs(def, values, domains)
	if !maps.Equal(gotValues, map[string]string{"mode": "create", "name": "x", "branch": "main"}) || len(gotDomains["branch"]) != 1 {
		t.Fatalf("create: values = %v domains = %v", gotValues, gotDomains)
	}
}
