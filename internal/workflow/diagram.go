package workflow

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
