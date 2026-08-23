package workflow

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/config"
)

func TestProjectDiagramHandoff(t *testing.T) {
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
	d := ProjectDiagram(*def)
	if len(d.Nodes) != 5 {
		t.Fatalf("nodes = %d, want 5", len(d.Nodes))
	}
	brief := d.Nodes[0]
	if brief.ID != "brief" || brief.Kind != "agent" {
		t.Fatalf("brief = %+v", brief)
	}
	if brief.Placement == nil || brief.Placement.Open != "tab" || brief.Placement.Close != "success" {
		t.Fatalf("brief placement = %+v", brief.Placement)
	}
	agentPane := d.Nodes[2]
	if agentPane.Kind != "agent" || agentPane.Placement == nil {
		t.Fatalf("agent pane step = %+v", agentPane)
	}
	if agentPane.Placement.Open != "{{inputs.placement}}" || !agentPane.Placement.Background {
		t.Fatalf("agent placement = %+v", agentPane.Placement)
	}
	tabClose := d.Nodes[3]
	if tabClose.Label != "tab.close" || len(tabClose.When) != 2 {
		t.Fatalf("tab.close = %+v", tabClose)
	}
	if tabClose.When[0].Path != "inputs.close_source" || tabClose.When[0].Value != "close" || tabClose.When[0].Negate {
		t.Fatalf("tab.close when[0] = %+v", tabClose.When[0])
	}
	if tabClose.When[1].Path != "inputs.placement" || tabClose.When[1].Value != "tab" || tabClose.When[1].Negate {
		t.Fatalf("tab.close when[1] = %+v", tabClose.When[1])
	}
	paneClose := d.Nodes[4]
	if paneClose.Label != "pane.close" || len(paneClose.When) != 2 {
		t.Fatalf("pane.close = %+v", paneClose)
	}
	if !paneClose.When[1].Negate || paneClose.When[1].Value != "tab" {
		t.Fatalf("pane.close when[1] = %+v", paneClose.When[1])
	}
}
