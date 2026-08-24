package console

import (
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

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
	if clause.Kind == workflow.WhenTruthy {
		return clause.Path
	}
	op := "=="
	if clause.Negate {
		op = "!="
	}
	return op + " " + clause.Path
}
