package workflow

import "strings"

// DiagramPlacement is one step's pane target on the workflow diagram.
type DiagramPlacement struct {
	Open       string
	Target     string
	Workspace  string
	Background bool
	Close      string
}

// DiagramNode is one projected step node.
type DiagramNode struct {
	Index     int
	ID        string
	Kind      string
	Label     string
	When      []WhenSpec
	Placement *DiagramPlacement
}

// Diagram is the read-only projection of a parsed workflow definition.
type Diagram struct {
	Nodes []DiagramNode
}

// ProjectDiagram derives step nodes, when edges, and placement targets from def.
func ProjectDiagram(def Definition) Diagram {
	nodes := make([]DiagramNode, 0, len(def.Steps))
	for i, step := range def.Steps {
		node := DiagramNode{
			Index: i + 1,
			ID:    step.ID,
			Kind:  ActionKind(step.Action),
			Label: diagramActionLabel(step.Action),
			When:  append([]WhenSpec(nil), step.When...),
		}
		if pane := diagramPaneOf(step.Action); pane != nil {
			node.Placement = diagramPlacementOf(pane, step.Action)
		}
		nodes = append(nodes, node)
	}
	return Diagram{Nodes: nodes}
}

func diagramActionLabel(action Action) string {
	switch value := action.(type) {
	case HerdrAction:
		return value.Method
	case WorkflowAction:
		return value.Name
	case RunAction:
		if !value.Payload.IsArgv() {
			return ""
		}
		return truncateDiagramLabel(strings.Join(value.Payload.Argv, " "), 24)
	case AgentAction:
		return truncateDiagramLabel(firstNonEmptyLine(value.Prompt), 24)
	default:
		return ""
	}
}

func diagramPaneOf(action Action) *PaneSpec {
	switch value := action.(type) {
	case AgentAction:
		return value.Pane
	case RunAction:
		return value.Pane
	default:
		return nil
	}
}

func diagramPlacementOf(pane *PaneSpec, action Action) *DiagramPlacement {
	if pane == nil {
		return nil
	}
	out := &DiagramPlacement{
		Open:      pane.Open,
		Target:    pane.Anchor,
		Workspace: pane.Workspace,
		Close:     pane.Close,
	}
	switch value := action.(type) {
	case AgentAction:
		out.Background = value.Background
	case RunAction:
		out.Background = value.Background
	}
	return out
}

func firstNonEmptyLine(s string) string {
	for _, line := range strings.Split(s, "\n") {
		if t := strings.TrimSpace(line); t != "" {
			return t
		}
	}
	return ""
}

func truncateDiagramLabel(s string, max int) string {
	s = strings.TrimSpace(s)
	if max <= 0 || s == "" {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	if max <= 3 {
		return string(runes[:max])
	}
	return string(runes[:max-3]) + "..."
}
