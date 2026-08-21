package host

import "testing"

func TestResultDotPathsIncludeKnownPaneFields(t *testing.T) {
	if len(resultDotPaths) == 0 {
		t.Fatal("resultDotPaths should not be empty")
	}
	if !resultDotPaths["pane.pane_id"] {
		t.Fatal("pane.pane_id should be a result dot path")
	}
	if resultDotPaths["pane.pane_ids"] {
		t.Fatal("pane.pane_ids should not be a result dot path")
	}
}

func TestPerMethodResultPathsStayMethodScoped(t *testing.T) {
	if Protocol != 20 {
		t.Fatalf("Protocol = %d, want 20", Protocol)
	}
	variants := methodResultVariants["notification.show"]
	if len(variants) != 1 || variants[0].Type != "notification_show" {
		t.Fatalf("notification.show variants = %+v", variants)
	}
	for _, tc := range []struct {
		method string
		field  string
		want   bool
	}{
		{"notification.show", "shown", true},
		{"notification.show", "worktree.path", false},
		{"worktree.create", "worktree.path", true},
		{"pane.wait_for_output", "matched_line", true},
		{"pane.wait_for_output", "read.text", true},
	} {
		if got := IsMethodResultDotPath(tc.method, tc.field); got != tc.want {
			t.Errorf("IsMethodResultDotPath(%q, %q) = %v, want %v", tc.method, tc.field, got, tc.want)
		}
	}
}
