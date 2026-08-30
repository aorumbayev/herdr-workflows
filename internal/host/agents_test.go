package host

import "testing"

// liveAgentList copies the shape of a real `herdr agent list` record: no title,
// no name, a stripped terminal title, and a numbered tab id.
func liveAgentList() map[string]any {
	return map[string]any{
		"agents": []any{
			map[string]any{
				"pane_id": "w5Z:p3", "tab_id": "w5Z:t2", "agent": "claude",
				"agent_status": "working", "focused": true,
				"terminal_title":          "◑ Picker popup dismiss and tab bar center",
				"terminal_title_stripped": "Picker popup dismiss and tab bar center",
			},
			map[string]any{
				"pane_id": "w5Z:p1", "tab_id": "w5Z:t1", "agent": "claude",
				"agent_status":            "done",
				"terminal_title":          "✳ Intake interrogator",
				"terminal_title_stripped": "Intake interrogator",
			},
			map[string]any{"pane_id": "", "agent_status": "idle"},
		},
	}
}

func TestParseAgentPanesReadsTheFieldsAgentListActuallyHas(t *testing.T) {
	got, err := ParseAgentPanes(liveAgentList(), "w5Z:p3")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if got[0].Tab != "1" || got[0].PaneID != "w5Z:p1" {
		t.Fatalf("tab order = %+v", got)
	}
	if got[0].Title != "Intake interrogator" {
		t.Fatalf("title must come from terminal_title_stripped: %+v", got[0])
	}
	if got[0].Status != "done" || got[0].Kind != "claude" {
		t.Fatalf("status and kind = %+v", got[0])
	}
	if got[0].Self {
		t.Fatalf("another pane must not be marked self: %+v", got[0])
	}
	if got[1].Tab != "2" || !got[1].Self {
		t.Fatalf("caller pane = %+v", got[1])
	}
	if got[1].Title != "Picker popup dismiss and tab bar center" {
		t.Fatalf("title = %q", got[1].Title)
	}
}

func TestParseAgentPanesPrefersARenamedAgentThenDegradesToThePaneID(t *testing.T) {
	got, err := ParseAgentPanes(map[string]any{
		"agents": []any{
			map[string]any{
				"pane_id": "w1:p1", "tab_id": "w1:t1", "name": "reviewer",
				"terminal_title_stripped": "vim config.yaml", "agent_status": "idle",
			},
			map[string]any{"pane_id": "w1:p2", "tab_id": "w1:t2", "agent_status": "blocked"},
			map[string]any{
				"pane_id": "w1:p3", "tab_id": "w1:t3",
				"terminal_title_stripped": "   ", "agent_status": "unknown",
			},
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if got[0].Title != "reviewer" {
		t.Fatalf("a renamed agent wins: %q", got[0].Title)
	}
	if got[1].Title != "w1:p2" {
		t.Fatalf("no title must degrade to the pane id: %q", got[1].Title)
	}
	if got[2].Title != "w1:p3" {
		t.Fatalf("a blank title must degrade to the pane id: %q", got[2].Title)
	}
	for _, pane := range got {
		if pane.Self {
			t.Fatalf("no HERDR_PANE_ID must mark nothing self: %+v", pane)
		}
	}
}

func TestParseAgentPanesOrdersTabsNumericallyAndKeepsOddIDsStable(t *testing.T) {
	got, err := ParseAgentPanes(map[string]any{
		"agents": []any{
			map[string]any{"pane_id": "w1:p4", "tab_id": "w1:t10"},
			map[string]any{"pane_id": "w1:p3", "tab_id": "w1:t9"},
			map[string]any{"pane_id": "w1:p2", "tab_id": "detached"},
			map[string]any{"pane_id": "w1:p1", "tab_id": ""},
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	var tabs []string
	for _, pane := range got {
		tabs = append(tabs, pane.Tab)
	}
	want := []string{"9", "10", "", "detached"}
	for i, tab := range want {
		if tabs[i] != tab {
			t.Fatalf("tab order = %v, want %v", tabs, want)
		}
	}
}

func TestPaneSendTextNotDenied(t *testing.T) {
	if _, denied := MethodDeniedReason("pane.send_text"); denied {
		t.Fatal("pane.send_text must not be denied")
	}
}
