package host

import "testing"

func TestParseAgentPanes(t *testing.T) {
	got, err := ParseAgentPanes(map[string]any{
		"agents": []any{
			map[string]any{"pane_id": "p2", "name": "beta", "title": "Beta"},
			map[string]any{"pane_id": "p1", "name": "alpha"},
			map[string]any{"pane_id": "", "name": "skip"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if got[0].PaneID != "p2" || got[0].Title != "Beta" {
		t.Fatalf("first = %+v", got[0])
	}
	if got[1].PaneID != "p1" || got[1].Title != "alpha" {
		t.Fatalf("second = %+v", got[1])
	}
}

func TestPaneSendTextNotDenied(t *testing.T) {
	if _, denied := MethodDeniedReason("pane.send_text"); denied {
		t.Fatal("pane.send_text must not be denied")
	}
}
