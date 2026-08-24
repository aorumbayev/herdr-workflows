package engine

import (
	"errors"
	"fmt"
	"slices"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestPlaceCommandPaneBeside(t *testing.T) {
	calls := []struct {
		method string
		params map[string]any
	}{}

	herdrCall := func(method string, params map[string]any) (map[string]any, error) {
		calls = append(calls, struct {
			method string
			params map[string]any
		}{method, params})
		if method == "pane.split" {
			return map[string]any{
				"pane": map[string]any{
					"pane_id":      "w1:pNew",
					"tab_id":       "w1:t1",
					"workspace_id": "w1",
				},
			}, nil
		}
		return map[string]any{"type": "ok"}, nil
	}

	placed, err := PlaceCommandPane(PlaceOpts{
		Open:   "beside",
		Anchor: "w1:pM",
		Focus:  false,
		Argv:   []string{"sh", "-c", "echo LISTENING; sleep 20"},
		Deps: RunnerDeps{
			HerdrCall: herdrCall,
		},
		Invocation: config.InvocationContext{
			PaneID:      "w1:pM",
			TabID:       "w1:t1",
			WorkspaceID: "w1",
		},
	})
	if err != nil {
		t.Fatalf("PlaceCommandPane failed: %v", err)
	}

	if placed.PaneID != "w1:pNew" {
		t.Errorf("placed.PaneID = %q, want %q", placed.PaneID, "w1:pNew")
	}

	methods := []string{}
	for _, c := range calls {
		methods = append(methods, c.method)
	}

	if !slices.Equal(methods, []string{"pane.split", "pane.send_input"}) {
		t.Errorf("methods = %v, want [pane.split pane.send_input]", methods)
	}

	splitCall := calls[0]
	if splitCall.params["direction"] != "right" {
		t.Errorf("split direction = %v, want right", splitCall.params["direction"])
	}
	if splitCall.params["target_pane_id"] != "w1:pM" {
		t.Errorf("split target = %v, want w1:pM", splitCall.params["target_pane_id"])
	}

	sendCall := calls[1]
	if sendCall.params["pane_id"] != "w1:pNew" {
		t.Errorf("send pane_id = %v, want w1:pNew", sendCall.params["pane_id"])
	}

	if !slices.Contains(sendCall.params["keys"].([]string), "Enter") {
		t.Errorf("send keys = %v, want to contain Enter", sendCall.params["keys"])
	}

	if !contains(fmt.Sprintf("%v", sendCall.params["text"]), "LISTENING") {
		t.Errorf("send text = %v, want to contain LISTENING", sendCall.params["text"])
	}

	if slices.ContainsFunc(calls, func(c struct {
		method string
		params map[string]any
	},
	) bool {
		return c.method == "layout.apply"
	}) {
		t.Error("layout.apply was called, should not be")
	}
}

func TestPlaceCommandPaneBelow(t *testing.T) {
	calls := []struct {
		method string
		params map[string]any
	}{}

	herdrCall := func(method string, params map[string]any) (map[string]any, error) {
		calls = append(calls, struct {
			method string
			params map[string]any
		}{method, params})
		if method == "pane.split" {
			return map[string]any{
				"pane": map[string]any{
					"pane_id":      "w1:p2",
					"tab_id":       "w1:t1",
					"workspace_id": "w1",
				},
			}, nil
		}
		return map[string]any{"type": "ok"}, nil
	}

	_, err := PlaceCommandPane(PlaceOpts{
		Open:  "below",
		Focus: true,
		Argv:  []string{"printf", "hi"},
		Deps: RunnerDeps{
			HerdrCall: herdrCall,
		},
		Invocation: config.InvocationContext{
			PaneID:      "w1:p1",
			TabID:       "w1:t1",
			WorkspaceID: "w1",
		},
	})
	if err != nil {
		t.Fatalf("PlaceCommandPane failed: %v", err)
	}

	if calls[0].params["direction"] != "down" {
		t.Errorf("split direction = %v, want down", calls[0].params["direction"])
	}
	if calls[0].params["target_pane_id"] != "w1:p1" {
		t.Errorf("split target = %v, want w1:p1", calls[0].params["target_pane_id"])
	}

	methods := []string{}
	for _, c := range calls {
		methods = append(methods, c.method)
	}
	if !slices.Equal(methods, []string{"pane.split", "pane.send_input"}) {
		t.Errorf("methods = %v, want [pane.split pane.send_input]", methods)
	}
}

func TestPlaceCommandPaneTab(t *testing.T) {
	calls := []struct {
		method string
		params map[string]any
	}{}

	herdrCall := func(method string, params map[string]any) (map[string]any, error) {
		calls = append(calls, struct {
			method string
			params map[string]any
		}{method, params})
		return map[string]any{
			"layout": map[string]any{
				"tab_id":          "w1:t2",
				"workspace_id":    "w1",
				"focused_pane_id": "w1:pTab",
				"root": map[string]any{
					"type":    "pane",
					"pane_id": "w1:pTab",
				},
			},
		}, nil
	}

	placed, err := PlaceCommandPane(PlaceOpts{
		Open:  "tab",
		Focus: true,
		Argv:  []string{"sh", "-c", "echo hi"},
		Deps: RunnerDeps{
			HerdrCall: herdrCall,
		},
		Invocation: config.InvocationContext{
			WorkspaceID: "w1",
		},
	})
	if err != nil {
		t.Fatalf("PlaceCommandPane failed: %v", err)
	}

	if placed.PaneID != "w1:pTab" {
		t.Errorf("placed.PaneID = %q, want %q", placed.PaneID, "w1:pTab")
	}

	if len(calls) != 1 {
		t.Errorf("herdrCall count = %d, want 1", len(calls))
	}

	if calls[0].method != "layout.apply" {
		t.Errorf("method = %q, want layout.apply", calls[0].method)
	}

	root := calls[0].params["root"].(map[string]any)
	if root["type"] != "pane" {
		t.Errorf("root type = %v, want pane", root["type"])
	}

	if !slices.Equal(root["command"].([]string), []string{"sh", "-c", "echo hi"}) {
		t.Errorf("command = %v, want [sh -c echo hi]", root["command"])
	}
}

func TestPlaceCommandPaneTabLabel(t *testing.T) {
	calls := []struct {
		method string
		params map[string]any
	}{}

	herdrCall := func(method string, params map[string]any) (map[string]any, error) {
		calls = append(calls, struct {
			method string
			params map[string]any
		}{method, params})
		return map[string]any{
			"layout": map[string]any{
				"tab_id":          "w1:t2",
				"workspace_id":    "w1",
				"focused_pane_id": "w1:pTab",
				"root": map[string]any{
					"type":    "pane",
					"pane_id": "w1:pTab",
				},
			},
		}, nil
	}

	_, err := PlaceCommandPane(PlaceOpts{
		Open:  "tab",
		Focus: true,
		Label: "dev server",
		Argv:  []string{"sh", "-c", "echo hi"},
		Deps: RunnerDeps{
			HerdrCall: herdrCall,
		},
		Invocation: config.InvocationContext{
			WorkspaceID: "w1",
		},
	})
	if err != nil {
		t.Fatalf("PlaceCommandPane failed: %v", err)
	}

	if calls[0].params["tab_label"] != "dev server" {
		t.Errorf("tab_label = %v, want dev server", calls[0].params["tab_label"])
	}
}

func TestQuoteArgvForShell(t *testing.T) {
	tests := []struct {
		name     string
		argv     []string
		expected string
	}{
		{
			name:     "simple tokens",
			argv:     []string{"echo", "hi"},
			expected: "echo hi",
		},
		{
			name:     "token with spaces and semicolon",
			argv:     []string{"sh", "-c", "echo LISTENING; sleep 1"},
			expected: "sh -c 'echo LISTENING; sleep 1'",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := QuoteArgvForShell(tc.argv)
			if got != tc.expected {
				t.Errorf("QuoteArgvForShell(%v) = %q, want %q", tc.argv, got, tc.expected)
			}
		})
	}
}

func TestQuotePosixArg(t *testing.T) {
	tests := []struct {
		name     string
		value    string
		expected string
	}{
		{
			name:     "empty string",
			value:    "",
			expected: "''",
		},
		{
			name:     "bare safe token",
			value:    "echo",
			expected: "echo",
		},
		{
			name:     "token with single quote",
			value:    "it's",
			expected: "'it'\\''s'",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := QuotePosixArg(tc.value)
			if got != tc.expected {
				t.Errorf("QuotePosixArg(%q) = %q, want %q", tc.value, got, tc.expected)
			}
		})
	}
}

func TestSizeToFirstRatio(t *testing.T) {
	tests := []struct {
		sizePercent int
		expected    float64
		tolerance   float64
	}{
		{40, 0.6, 0.0001},
		{99, 0.01, 0.0001},
	}

	for _, tc := range tests {
		got := SizeToFirstRatio(tc.sizePercent)
		if absDiff(got, tc.expected) > tc.tolerance {
			t.Errorf("SizeToFirstRatio(%d) = %f, want ~%f", tc.sizePercent, got, tc.expected)
		}
	}
}

func TestResolvePaneOpen(t *testing.T) {
	tests := []struct {
		name    string
		open    string
		ns      workflow.TemplateNamespace
		want    string
		wantErr bool
	}{
		{
			name:    "tab literal",
			open:    "tab",
			ns:      workflow.TemplateNamespace{},
			want:    "tab",
			wantErr: false,
		},
		{
			name:    "beside literal",
			open:    "beside",
			ns:      workflow.TemplateNamespace{},
			want:    "beside",
			wantErr: false,
		},
		{
			name:    "below literal",
			open:    "below",
			ns:      workflow.TemplateNamespace{},
			want:    "below",
			wantErr: false,
		},
		{
			name: "template resolving to tab",
			open: "{{context.pane_open}}",
			ns: workflow.TemplateNamespace{
				Context: map[string]any{"pane_open": "tab"},
			},
			want:    "tab",
			wantErr: false,
		},
		{
			name: "template resolving to bad value",
			open: "{{context.pane_open}}",
			ns: workflow.TemplateNamespace{
				Context: map[string]any{"pane_open": "invalid"},
			},
			want:    "",
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ResolvePaneOpen(tc.open, tc.ns)
			if (err != nil) != tc.wantErr {
				t.Errorf("ResolvePaneOpen() error = %v, wantErr %v", err, tc.wantErr)
			}
			if !tc.wantErr && got != tc.want {
				t.Errorf("ResolvePaneOpen() = %q, want %q", got, tc.want)
			}
		})
	}
}

// Test helpers.
func contains(s, substr string) bool {
	for i := 0; i < len(s)-len(substr)+1; i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func absDiff(a, b float64) float64 {
	if a < b {
		return b - a
	}
	return a - b
}

func TestPlacementFailures(t *testing.T) {
	okCall := func(map[string]any) (map[string]any, error) {
		return map[string]any{"type": "ok"}, nil
	}
	cases := []struct {
		name    string
		opts    PlaceOpts
		reply   func(map[string]any) (map[string]any, error)
		wantMsg string
	}{
		{
			name:    "tab without a workspace",
			opts:    PlaceOpts{Open: "tab"},
			reply:   okCall,
			wantMsg: "pane.open: tab needs pane.workspace or an invocation workspace",
		},
		{
			name:    "beside without an anchor",
			opts:    PlaceOpts{Open: "beside"},
			reply:   okCall,
			wantMsg: "pane.open: beside needs pane.target or an invocation pane",
		},
		{
			name:    "below without an anchor",
			opts:    PlaceOpts{Open: "below"},
			reply:   okCall,
			wantMsg: "pane.open: below needs pane.target or an invocation pane",
		},
		{
			name:    "split reply without identifiers",
			opts:    PlaceOpts{Open: "beside", Anchor: "w1:pM"},
			reply:   okCall,
			wantMsg: "pane.split did not return pane/tab/workspace identifiers",
		},
		{
			name:    "tab.create reply without identifiers",
			opts:    PlaceOpts{Open: "tab", Workspace: "w1"},
			reply:   okCall,
			wantMsg: "tab.create did not return pane/tab/workspace identifiers",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			opts := tc.opts
			opts.Deps = RunnerDeps{
				HerdrCall: func(_ string, params map[string]any) (map[string]any, error) {
					return tc.reply(params)
				},
			}
			_, err := PlaceEmptyPane(opts)
			if err == nil {
				t.Fatalf("PlaceEmptyPane succeeded, want %q", tc.wantMsg)
			}
			var herdrErr *host.HerdrError
			if !errors.As(err, &herdrErr) {
				t.Fatalf("error is %T, want *host.HerdrError", err)
			}
			if herdrErr.Code != "placement_failed" {
				t.Errorf("code = %q, want placement_failed", herdrErr.Code)
			}
			if herdrErr.Msg != tc.wantMsg {
				t.Errorf("message = %q, want %q", herdrErr.Msg, tc.wantMsg)
			}
		})
	}
}

func TestPlaceCommandPaneLayoutWithoutIdentifiers(t *testing.T) {
	_, err := PlaceCommandPane(PlaceOpts{
		Open:      "tab",
		Workspace: "w1",
		Argv:      []string{"echo", "hi"},
		Deps: RunnerDeps{
			HerdrCall: func(string, map[string]any) (map[string]any, error) {
				return map[string]any{"layout": map[string]any{}}, nil
			},
		},
	})
	if err == nil {
		t.Fatal("PlaceCommandPane succeeded, want a placement failure")
	}
	var herdrErr *host.HerdrError
	if !errors.As(err, &herdrErr) {
		t.Fatalf("error is %T, want *host.HerdrError", err)
	}
	if herdrErr.Msg != "layout.apply did not return tab/workspace identifiers" {
		t.Errorf("message = %q", herdrErr.Msg)
	}
}
