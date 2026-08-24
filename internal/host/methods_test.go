package host

import (
	"regexp"
	"strings"
	"testing"
)

// Copy of the shape of workflow.IsWholeValueTemplate. The host package cannot import workflow.
var wholeTemplateRE = regexp.MustCompile(`^\{\{\s*(?:inputs|steps|context)(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+\s*\}\}$`)

func wholeTemplate(text string) bool {
	return wholeTemplateRE.MatchString(text)
}

func TestValidateHerdrInvocation(t *testing.T) {
	cases := []struct {
		name    string
		method  string
		params  map[string]any
		wantErr string
	}{
		{name: "ping", method: "ping"},
		{name: "unknown", method: "pane.splitt", wantErr: "unknown herdr method 'pane.splitt'"},
		{name: "denied", method: "server.stop", wantErr: "server.stop: would stop the server running the workflow"},
		{name: "denied area", method: "plugin.list", wantErr: "plugin lifecycle methods are not available to workflows"},
		{
			name:    "denied plugin disable",
			method:  "plugin.disable",
			params:  map[string]any{"plugin_id": "herdr-workflows"},
			wantErr: "plugin lifecycle methods are not available to workflows",
		},
		{
			name:    "denied agent view filter",
			method:  "agent.view.set",
			params:  map[string]any{"source": "x"},
			wantErr: "agent view filters are client UI state, not workflow automation",
		},
		{
			name:   "optional anchor stays optional",
			method: "workspace.move_block",
			params: map[string]any{"workspace_ids": []any{"w1"}},
		},
		{
			name:   "whole-value direction template",
			method: "pane.split",
			params: map[string]any{"direction": "{{inputs.d}}", "target_pane_id": "w1:p1"},
		},
		{
			name:   "whole-value zoom mode template",
			method: "pane.zoom",
			params: map[string]any{"mode": "{{inputs.z}}", "pane_id": "w1:p1"},
		},
		{
			name:    "split direction enum violation",
			method:  "pane.split",
			params:  map[string]any{"direction": "sideways", "target_pane_id": "w1:p1"},
			wantErr: "param 'direction' must be one of",
		},
		{
			name:    "missing required",
			method:  "notification.show",
			wantErr: "notification.show: missing required param 'title'",
		},
		{
			name:    "unknown param",
			method:  "notification.show",
			params:  map[string]any{"title": "hi", "nope": 1},
			wantErr: "notification.show: unknown param 'nope'",
		},
		{
			name:    "enum violation",
			method:  "notification.show",
			params:  map[string]any{"title": "hi", "sound": "loud"},
			wantErr: `notification.show: param 'sound' must be one of none, done, request`,
		},
		{
			name:    "kind mismatch",
			method:  "notification.show",
			params:  map[string]any{"title": 3},
			wantErr: "notification.show: param 'title' expects string",
		},
		{
			name:    "non-template mustache still faces shape checks",
			method:  "notification.show",
			params:  map[string]any{"title": "{{bogus}}", "sound": "{{bogus}}"},
			wantErr: `notification.show: param 'sound' must be one of none, done, request`,
		},
		{
			name:   "whole-value template skips shape checks",
			method: "notification.show",
			params: map[string]any{"title": "{{inputs.t}}"},
		},
		{
			name:    "focus require",
			method:  "pane.split",
			params:  map[string]any{"direction": "right"},
			wantErr: "pane.split: params.target_pane_id is required — raw herdr calls never fall back to live herdr focus",
		},
		{
			name:   "focus require satisfied",
			method: "pane.split",
			params: map[string]any{"direction": "right", "target_pane_id": "w1:p1"},
		},
		{
			name:    "focus exactly one",
			method:  "worktree.create",
			params:  map[string]any{"branch": "{{inputs.branch}}"},
			wantErr: "worktree.create: needs exactly one of workspace_id or cwd — raw herdr calls never fall back to live herdr focus",
		},
		{
			name:   "focus exactly one satisfied",
			method: "worktree.create",
			params: map[string]any{"cwd": "/repo"},
		},
		{
			name:    "swap needs a pair",
			method:  "pane.swap",
			wantErr: "pane.swap: needs direction with pane_id, or both source_pane_id and target_pane_id — raw herdr calls never fall back to live herdr focus",
		},
		{
			name:   "swap with pair",
			method: "pane.swap",
			params: map[string]any{"source_pane_id": "w1:p1", "target_pane_id": "w1:p2"},
		},
		{
			name:    "move destination object",
			method:  "pane.move",
			params:  map[string]any{"pane_id": "w1:p1", "destination": "tab"},
			wantErr: "pane.move: param 'destination' expects object",
		},
		{
			name:   "move to tab",
			method: "pane.move",
			params: map[string]any{"pane_id": "w1:p1", "destination": map[string]any{"type": "tab", "target_pane_id": "w1:p2"}},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateHerdrInvocation(tc.method, tc.params, wholeTemplate)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("got %v, want substring %q", err, tc.wantErr)
			}
		})
	}
}

func TestAssertFocusPolicy(t *testing.T) {
	cases := []struct {
		name   string
		method string
		params map[string]any
		want   string
	}{
		{"pane.split without an anchor", "pane.split", map[string]any{"direction": "right"}, "target_pane_id"},
		{"pane.split with an anchor", "pane.split", map[string]any{"direction": "right", "target_pane_id": "w-pane-1"}, ""},
		{"tab.create without a workspace", "tab.create", map[string]any{}, "workspace_id"},
		{"pane.current with a caller pane", "pane.current", map[string]any{"caller_pane_id": "w-pane-1"}, ""},
		{"pane.zoom with a blank pane id", "pane.zoom", map[string]any{"pane_id": ""}, "pane_id"},

		{"layout.apply with both selectors", "layout.apply", map[string]any{"workspace_id": "w", "tab_id": "t"}, "exactly one"},
		{"layout.apply with one selector", "layout.apply", map[string]any{"tab_id": "t"}, ""},
		{"worktree.list with no selector", "worktree.list", map[string]any{}, "exactly one"},
		{"worktree.create with a cwd", "worktree.create", map[string]any{"cwd": "/repo"}, ""},
		{"layout.export with no selector", "layout.export", map[string]any{}, "one of"},
		{"layout.set_split_ratio with a pane", "layout.set_split_ratio", map[string]any{"pane_id": "p"}, ""},

		{"pane.swap by direction alone", "pane.swap", map[string]any{"direction": "right"}, "direction"},
		{"pane.swap by direction and pane", "pane.swap", map[string]any{"direction": "right", "pane_id": "p"}, ""},
		{"pane.swap by explicit pair", "pane.swap", map[string]any{"source_pane_id": "a", "target_pane_id": "b"}, ""},

		{"pane.move to a tab without a target", "pane.move", map[string]any{"pane_id": "p", "destination": map[string]any{"type": "tab", "tab_id": "t"}}, "target_pane_id"},
		{"pane.move to a tab with a target", "pane.move", map[string]any{"pane_id": "p", "destination": map[string]any{"type": "tab", "tab_id": "t", "split": "right", "target_pane_id": "q"}}, ""},
		{"pane.move to a new tab without a workspace", "pane.move", map[string]any{"pane_id": "p", "destination": map[string]any{"type": "new_tab"}}, "workspace_id"},
		{"pane.move to a new workspace", "pane.move", map[string]any{"pane_id": "p", "destination": map[string]any{"type": "new_workspace"}}, ""},

		{"unconstrained method", "notification.show", map[string]any{"title": "hi"}, ""},

		{"pane.list filter scope is optional", "pane.list", map[string]any{}, ""},
		{"tab.list filter scope is optional", "tab.list", map[string]any{}, ""},
		{"unclassified method", "pane.rotate", map[string]any{}, "unclassified method"},
		{"pane.edges needs its pane", "pane.edges", map[string]any{}, "pane_id"},

		{"templated branch does not waive the worktree selector", "worktree.create", map[string]any{"branch": "{{inputs.branch}}"}, "exactly one"},
		{"templated label does not waive the tab workspace", "tab.create", map[string]any{"label": "{{inputs.l}}"}, "workspace_id"},
		{"templated cwd satisfies the worktree selector", "worktree.create", map[string]any{"cwd": "{{inputs.cwd}}", "branch": "{{inputs.branch}}"}, ""},
		{"templated workspace satisfies tab.create", "tab.create", map[string]any{"workspace_id": "{{context.workspace}}", "label": "{{inputs.l}}"}, ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := assertFocusPolicy(tc.method, tc.params)
			if tc.want == "" {
				if got != nil {
					t.Fatalf("assertFocusPolicy(%q) = %v, want no error", tc.method, got)
				}
				return
			}
			if got == nil || !strings.Contains(got.Error(), tc.want) {
				t.Fatalf("assertFocusPolicy(%q) = %v, want substring %q", tc.method, got, tc.want)
			}
		})
	}
}
