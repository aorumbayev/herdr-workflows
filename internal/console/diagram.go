package console

import (
	"fmt"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

// FormatDiagram renders a projected workflow diagram as ASCII lines.
func FormatDiagram(d workflow.Diagram, width int) string {
	if width <= 0 {
		width = 80
	}
	var lines []string
	for i, node := range d.Nodes {
		if i > 0 {
			lines = append(lines, diagramEdgeLine(width))
		}
		lines = append(lines, formatDiagramNode(node, width)...)
	}
	return strings.Join(lines, "\n")
}

func formatDiagramNode(node workflow.DiagramNode, width int) []string {
	head := formatDiagramNodeHead(node)
	lines := []string{tui.Truncate(head, width)}
	if node.Placement != nil {
		lines = append(lines, tui.Truncate(formatDiagramPlacement(node.Placement), width))
	}
	for _, clause := range node.When {
		lines = append(lines, tui.Truncate("when: "+formatDiagramWhen(clause), width))
	}
	return lines
}

func formatDiagramNodeHead(node workflow.DiagramNode) string {
	name := node.ID
	if name == "" {
		name = fmt.Sprintf("step %d", node.Index)
	}
	label := node.Kind
	if node.Label != "" {
		label = node.Label
	}
	return fmt.Sprintf("%s (%s)", name, label)
}

func formatDiagramPlacement(p *workflow.DiagramPlacement) string {
	var parts []string
	if p.Open != "" {
		parts = append(parts, "pane: "+p.Open)
	}
	if p.Target != "" {
		parts = append(parts, "target: "+p.Target)
	}
	if p.Workspace != "" {
		parts = append(parts, "workspace: "+p.Workspace)
	}
	if p.Background {
		parts = append(parts, "bg")
	}
	if p.Close != "" {
		parts = append(parts, "close: "+p.Close)
	}
	if len(parts) == 0 {
		return ""
	}
	return strings.Join(parts, " ")
}

func formatDiagramWhen(clause workflow.WhenSpec) string {
	path := "{{" + clause.Path + "}}"
	if clause.Kind == workflow.WhenTruthy {
		return path
	}
	op := "=="
	if clause.Negate {
		op = "!="
	}
	return fmt.Sprintf("%s %s %q", path, op, clause.Value)
}

func diagramEdgeLine(width int) string {
	line := "  |"
	if width > 4 {
		line = tui.Truncate("  |", width)
	}
	return line
}
