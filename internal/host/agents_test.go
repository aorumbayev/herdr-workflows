package host

import "testing"

// liveAgentList copies the shape of real `herdr agent list`, `herdr workspace
// list`, and `herdr tab list` records: base-36 ids and two agents in one tab.
func liveAgentList() (agents, workspaces, tabs map[string]any) {
	agents = map[string]any{
		"agents": []any{
			map[string]any{
				"pane_id": "w6E:pV", "tab_id": "w6E:tC", "workspace_id": "w6E", "agent": "claude",
				"agent_status": "working", "name": "reviewer",
				"terminal_title":          "◑ Reviewer persona and protocol",
				"terminal_title_stripped": "Reviewer persona and protocol",
			},
			map[string]any{
				"pane_id": "w6E:pT", "tab_id": "w6E:tC", "workspace_id": "w6E", "agent": "claude",
				"agent_status":            "working",
				"terminal_title":          "◑ Subagent adversarial validation",
				"terminal_title_stripped": "Subagent adversarial validation",
			},
			map[string]any{
				"pane_id": "w6E:p5", "tab_id": "w6E:t4", "workspace_id": "w6E", "agent": "claude",
				"agent_status":            "working",
				"terminal_title_stripped": "Implementer persona setup",
			},
			map[string]any{
				"pane_id": "w68:p1", "tab_id": "w68:t1", "workspace_id": "w68", "agent": "claude",
				"agent_status":            "idle",
				"terminal_title_stripped": "Assigned tickets query",
			},
			map[string]any{"pane_id": "", "agent_status": "idle"},
		},
	}
	workspaces = map[string]any{
		"workspaces": []any{
			map[string]any{"workspace_id": "w68", "label": "operational-support", "number": float64(1)},
			map[string]any{"workspace_id": "w6E", "label": "herdr-workflows", "number": float64(3)},
		},
	}
	tabs = map[string]any{
		"tabs": []any{
			map[string]any{"tab_id": "w68:t1", "workspace_id": "w68", "label": "claude › Assigned tickets query", "number": float64(1)},
			map[string]any{"tab_id": "w6E:t4", "workspace_id": "w6E", "label": "hwf-agent", "number": float64(4)},
			map[string]any{"tab_id": "w6E:tC", "workspace_id": "w6E", "label": "ponytail-cuts › claude › Reviewer persona and protocol", "number": float64(12)},
		},
	}
	return agents, workspaces, tabs
}

func TestParseAgentPanesJoinsWorkspaceAndTabByID(t *testing.T) {
	agents, workspaces, tabs := liveAgentList()
	got, err := ParseAgentPanes(agents, workspaces, tabs, "w6E:pV")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 4 {
		t.Fatalf("len = %d, want 4", len(got))
	}
	var order []string
	for _, pane := range got {
		order = append(order, pane.PaneID)
	}
	want := []string{"w68:p1", "w6E:p5", "w6E:pT", "w6E:pV"}
	for i, id := range want {
		if order[i] != id {
			t.Fatalf("order = %v, want workspace, tab number, pane id: %v", order, want)
		}
	}
	first := got[0]
	if first.Workspace != "operational-support" || first.Tab != "claude › Assigned tickets query" || first.TabNumber != 1 {
		t.Fatalf("workspace and tab must come from their lists: %+v", first)
	}
	if first.Title != "Assigned tickets query" || first.Kind != "claude" || first.Status != "idle" || first.Self {
		t.Fatalf("first = %+v", first)
	}
	if got[1].Tab != "hwf-agent" || got[1].TabNumber != 4 {
		t.Fatalf("tab tC must not parse as a number and t4 must read tab.list: %+v", got[1])
	}
	shared := got[2:]
	if shared[0].Tab != shared[1].Tab || shared[0].TabNumber != 12 || shared[1].TabNumber != 12 {
		t.Fatalf("two agents in one tab share its label and number: %+v", shared)
	}
	if shared[0].PaneID == shared[1].PaneID {
		t.Fatalf("pane ids must tell the two agents apart: %+v", shared)
	}
	if shared[1].Title != "reviewer" || !shared[1].Self {
		t.Fatalf("a renamed caller pane = %+v", shared[1])
	}
}

func TestParseAgentPanesDegradesWithoutLocationsOrTitle(t *testing.T) {
	got, err := ParseAgentPanes(map[string]any{
		"agents": []any{
			map[string]any{"pane_id": "w1:p2", "tab_id": "w1:t2", "agent_status": "blocked"},
			map[string]any{
				"pane_id": "w1:p3", "tab_id": "w1:t3", "workspace_id": "w1",
				"terminal_title_stripped": "   ", "agent_status": "unknown",
			},
		},
	}, nil, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, pane := range got {
		if pane.Title != "" || pane.Workspace != "" || pane.Tab != "" || pane.TabNumber != 0 {
			t.Fatalf("no title and no lists must leave the fields empty: %+v", pane)
		}
		if pane.Self {
			t.Fatalf("no HERDR_PANE_ID must mark nothing self: %+v", pane)
		}
	}
	if got[0].PaneID != "w1:p2" || got[1].PaneID != "w1:p3" {
		t.Fatalf("unlocated panes sort by pane id: %+v", got)
	}
}

func TestParseAgentPanesRejectsAMissingAgentList(t *testing.T) {
	if _, err := ParseAgentPanes(nil, nil, nil, ""); err == nil {
		t.Fatal("nil agent list must fail")
	}
}

func TestPaneSendTextNotDenied(t *testing.T) {
	for _, method := range []string{"pane.send_text", "agent.list", "workspace.list", "tab.list"} {
		if _, denied := MethodDeniedReason(method); denied {
			t.Fatalf("%s must not be denied", method)
		}
	}
}
