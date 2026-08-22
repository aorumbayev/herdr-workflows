package workflow

import (
	"fmt"
	"slices"

	"gopkg.in/yaml.v3"
)

// FormatStepYAML emits one reviewable YAML list item for step.
func FormatStepYAML(step Step) (string, error) {
	data, err := yaml.Marshal(dumpSequence([]*yaml.Node{dumpStepNode(step)}))
	if err != nil {
		return "", fmt.Errorf("format step yaml: %w", err)
	}
	return string(data), nil
}

// StepYAMLFragments returns YAML list items for the named step ids in def.
func StepYAMLFragments(def Definition, ids []string) (map[string]string, error) {
	out := make(map[string]string, len(ids))
	for _, id := range ids {
		idx := slices.IndexFunc(def.Steps, func(step Step) bool { return step.ID == id })
		if idx < 0 {
			return nil, fmt.Errorf("step %q not found", id)
		}
		text, err := FormatStepYAML(def.Steps[idx])
		if err != nil {
			return nil, err
		}
		out[id] = text
	}
	return out, nil
}
