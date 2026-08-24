package engine

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

// fakeHerdrCall records calls so that tests can assert.
type fakeHerdrCall struct {
	calls []herdrCallRecord
}

type herdrCallRecord struct {
	method string
	params map[string]any
}

func (f *fakeHerdrCall) call(method string, params map[string]any) (map[string]any, error) {
	f.calls = append(f.calls, herdrCallRecord{method, params})
	return f.defaultResponse(method, params), nil
}

func (f *fakeHerdrCall) defaultResponse(method string, params map[string]any) map[string]any {
	switch method {
	case "pane.split":
		return map[string]any{
			"pane": map[string]any{
				"pane_id":      "w1:p3",
				"tab_id":       "w1:t1",
				"workspace_id": "w1",
			},
		}
	case "tab.create":
		return map[string]any{
			"tab": map[string]any{
				"tab_id":       "w1:t2",
				"workspace_id": "w1",
			},
			"root_pane": map[string]any{
				"pane_id":      "w1:p3",
				"tab_id":       "w1:t2",
				"workspace_id": "w1",
			},
		}
	case "layout.apply":
		return map[string]any{
			"layout": map[string]any{
				"tab_id":          "w1:t2",
				"workspace_id":    "w1",
				"focused_pane_id": "w1:p3",
				"root": map[string]any{
					"type":    "pane",
					"pane_id": "w1:p3",
				},
			},
		}
	case "pane.wait_for_output":
		return map[string]any{
			"read": map[string]any{
				"output":    "ready output",
				"truncated": false,
			},
		}
	default:
		return map[string]any{"type": "ok"}
	}
}

func TestShellStepReservedEnvKey(t *testing.T) {
	frame := StepFrame{
		Step: workflow.Step{
			ID: "test",
			Action: &workflow.RunAction{
				Payload: workflow.RunPayload{
					Command: "echo hi",
					Shell:   "sh",
				},
				Env: map[string]string{
					"HWF_name": "x",
				},
			},
		},
		Values: workflow.TemplateNamespace{
			Inputs: map[string]any{},
		},
		Opts: StepRunOpts{
			Ctx: config.InvocationContext{
				Cwd: t.TempDir(),
			},
			Deps: RunnerDeps{
				HerdrCall: (&fakeHerdrCall{}).call,
			},
		},
	}

	outcome, err := ShellStep(frame)
	if err != nil {
		t.Fatalf("ShellStep returned error: %v", err)
	}

	if outcome.OK {
		t.Errorf("ShellStep.OK = true, want false (should reject reserved env key)")
	}

	if !strings.Contains(outcome.Error, "reserved HWF_") {
		t.Errorf("ShellStep error = %q, want to contain 'reserved HWF_'", outcome.Error)
	}
}

func TestShellStepPlacedBesideRun(t *testing.T) {
	fake := &fakeHerdrCall{}
	frame := StepFrame{
		Step: workflow.Step{
			ID: "boot",
			Action: &workflow.RunAction{
				Payload: workflow.RunPayload{
					Argv: []string{"sh", "-c", "echo LISTENING"},
				},
				Pane: &workflow.PaneSpec{
					Open:   "beside",
					Anchor: "w1:pM",
				},
				ReadyWhen: "LISTENING",
				Timeout:   5 * time.Second,
			},
		},
		Values: workflow.TemplateNamespace{
			Inputs: map[string]any{},
			Context: map[string]any{
				"cwd": t.TempDir(),
			},
		},
		Opts: StepRunOpts{
			Ctx: config.InvocationContext{
				PaneID:      "w1:p1",
				TabID:       "w1:t1",
				WorkspaceID: "w1",
				Cwd:         t.TempDir(),
			},
			Deps: RunnerDeps{
				HerdrCall: fake.call,
			},
		},
	}

	outcome, err := ShellStep(frame)
	if err != nil {
		t.Fatalf("ShellStep returned error: %v", err)
	}

	if !outcome.OK {
		t.Errorf("ShellStep.OK = false, want true. Error: %v", outcome.Error)
	}

	// Make sure that the test does not call layout.apply
	hasLayoutApply := slices.ContainsFunc(fake.calls, func(r herdrCallRecord) bool {
		return r.method == "layout.apply"
	})
	if hasLayoutApply {
		t.Error("layout.apply was called, should not be for beside")
	}

	// Make sure that the test calls split with the correct direction
	splitCall := findCall(fake.calls, "pane.split")
	if splitCall == nil {
		t.Fatal("pane.split was not called")
	}
	if splitCall.params["direction"] != "right" {
		t.Errorf("split direction = %v, want right", splitCall.params["direction"])
	}

	// Make sure that the test calls send_input
	sendCall := findCall(fake.calls, "pane.send_input")
	if sendCall == nil {
		t.Fatal("pane.send_input was not called")
	}
	if sendCall.params["pane_id"] != "w1:p3" {
		t.Errorf("send pane_id = %v, want w1:p3", sendCall.params["pane_id"])
	}
	if !slices.Contains(sendCall.params["keys"].([]string), "Enter") {
		t.Errorf("send keys does not contain Enter")
	}
}

func TestShellStepReadinessDefaults(t *testing.T) {
	fake := &fakeHerdrCall{}
	frame := StepFrame{
		Step: workflow.Step{
			ID: "boot",
			Action: &workflow.RunAction{
				Payload: workflow.RunPayload{
					Argv: []string{"sh", "-c", "printf ready"},
				},
				Pane: &workflow.PaneSpec{
					Open: "tab",
				},
				ReadyWhen: "ready",
				Timeout:   5 * time.Second,
			},
		},
		Values: workflow.TemplateNamespace{
			Inputs: map[string]any{},
			Context: map[string]any{
				"cwd": t.TempDir(),
			},
		},
		Opts: StepRunOpts{
			Ctx: config.InvocationContext{
				WorkspaceID: "w1",
				TabID:       "w1:t1",
				PaneID:      "w1:p1",
				Cwd:         t.TempDir(),
			},
			Deps: RunnerDeps{
				HerdrCall: fake.call,
			},
		},
	}

	outcome, err := ShellStep(frame)
	if err != nil {
		t.Fatalf("ShellStep returned error: %v", err)
	}

	if !outcome.OK {
		t.Errorf("ShellStep.OK = false, want true. Error: %v", outcome.Error)
	}

	// Make sure that the test calls pane.wait_for_output with the correct defaults
	waitCall := findCall(fake.calls, "pane.wait_for_output")
	if waitCall == nil {
		t.Fatal("pane.wait_for_output was not called")
	}

	if waitCall.params["source"] != "recent" {
		t.Errorf("wait source = %v, want recent", waitCall.params["source"])
	}
	if waitCall.params["lines"] != 80 {
		t.Errorf("wait lines = %v, want 80", waitCall.params["lines"])
	}
	if waitCall.params["strip_ansi"] != true {
		t.Errorf("wait strip_ansi = %v, want true", waitCall.params["strip_ansi"])
	}

	match := waitCall.params["match"].(map[string]any)
	if match["type"] != "regex" {
		t.Errorf("match type = %v, want regex", match["type"])
	}
	if match["value"] != "ready" {
		t.Errorf("match value = %v, want ready", match["value"])
	}

	if waitCall.params["timeout_ms"] != 5000 {
		t.Errorf("timeout_ms = %v, want 5000", waitCall.params["timeout_ms"])
	}
}

func TestShellStepReadinessSpreadsNativeWaitResult(t *testing.T) {
	fake := &fakeHerdrCall{}
	frame := StepFrame{
		Step: workflow.Step{
			ID: "boot",
			Action: &workflow.RunAction{
				Payload: workflow.RunPayload{
					Argv: []string{"echo", "ready"},
				},
				Pane: &workflow.PaneSpec{
					Open: "tab",
				},
				ReadyWhen: "ready",
				Timeout:   5 * time.Second,
			},
		},
		Values: workflow.TemplateNamespace{
			Inputs:  map[string]any{},
			Context: map[string]any{"cwd": t.TempDir()},
		},
		Opts: StepRunOpts{
			Ctx: config.InvocationContext{
				WorkspaceID: "w1",
				TabID:       "w1:t1",
				PaneID:      "w1:p1",
				Cwd:         t.TempDir(),
			},
			Deps: RunnerDeps{
				HerdrCall: func(method string, params map[string]any) (map[string]any, error) {
					res, err := fake.call(method, params)
					if method == "pane.wait_for_output" {
						return map[string]any{
							"matched_line": "ready",
							"pane_id":      "native-pane",
							"read": map[string]any{
								"text":      "ready output",
								"truncated": true,
							},
							"revision": 7,
						}, nil
					}
					return res, err
				},
			},
		},
	}

	outcome, err := ShellStep(frame)
	if err != nil {
		t.Fatalf("ShellStep returned error: %v", err)
	}
	if !outcome.OK {
		t.Fatalf("ShellStep.OK = false, want true. Error: %v", outcome.Error)
	}
	if !outcome.Truncated {
		t.Fatal("Truncated = false, want true")
	}
	result, ok := outcome.Result.(map[string]any)
	if !ok {
		t.Fatalf("Result type %T, want map[string]any", outcome.Result)
	}
	if result["matched_line"] != "ready" {
		t.Fatalf("matched_line = %v, want ready", result["matched_line"])
	}
	read, ok := result["read"].(map[string]any)
	if !ok {
		t.Fatalf("read type %T, want map[string]any", result["read"])
	}
	if read["text"] != "ready output" {
		t.Fatalf("read.text = %v, want ready output", read["text"])
	}
	if read["truncated"] != true {
		t.Fatalf("read.truncated = %v, want true", read["truncated"])
	}
	if result["pane_id"] != "w1:p3" {
		t.Fatalf("pane_id = %v, want placed overlay w1:p3", result["pane_id"])
	}
	if result["tab_id"] != "w1:t2" {
		t.Fatalf("tab_id = %v, want placed overlay w1:t2", result["tab_id"])
	}
	if result["workspace_id"] != "w1" {
		t.Fatalf("workspace_id = %v, want w1", result["workspace_id"])
	}
}

func TestShellStepBackgroundPlacedRun(t *testing.T) {
	fake := &fakeHerdrCall{}
	frame := StepFrame{
		Step: workflow.Step{
			ID: "serve",
			Action: &workflow.RunAction{
				Payload: workflow.RunPayload{
					Argv: []string{"sh", "-c", "sleep 100"},
				},
				Pane: &workflow.PaneSpec{
					Open: "tab",
				},
				Background: true,
			},
		},
		Values: workflow.TemplateNamespace{
			Inputs: map[string]any{},
			Context: map[string]any{
				"cwd": t.TempDir(),
			},
		},
		Opts: StepRunOpts{
			Ctx: config.InvocationContext{
				WorkspaceID: "w1",
				Cwd:         t.TempDir(),
			},
			Deps: RunnerDeps{
				HerdrCall: fake.call,
			},
		},
	}

	outcome, err := ShellStep(frame)
	if err != nil {
		t.Fatalf("ShellStep returned error: %v", err)
	}

	if !outcome.OK {
		t.Errorf("ShellStep.OK = false, want true. Error: %v", outcome.Error)
	}

	if !outcome.Launched {
		t.Errorf("ShellStep.Launched = false, want true")
	}

	if outcome.Result != nil {
		t.Errorf("ShellStep.Result = %v, want nil for background run", outcome.Result)
	}
}

func TestPlaceEmptyPaneTabLabel(t *testing.T) {
	fake := &fakeHerdrCall{}
	ns := workflow.TemplateNamespace{
		Inputs: map[string]any{"branch": "fix-tabs"},
	}
	paneName := "review {{inputs.branch}}"

	label := ResolvePaneLabel(paneName, ns, "launch")

	_, err := PlaceEmptyPane(PlaceOpts{
		Open:  "tab",
		Label: label,
		Deps: RunnerDeps{
			HerdrCall: fake.call,
		},
		Invocation: config.InvocationContext{
			WorkspaceID: "w1",
		},
	})
	if err != nil {
		t.Fatalf("PlaceEmptyPane failed: %v", err)
	}

	createCall := findCall(fake.calls, "tab.create")
	if createCall == nil {
		t.Fatal("tab.create was not called")
	}
	if createCall.params["label"] != "review fix-tabs" {
		t.Errorf("tab label = %v, want 'review fix-tabs'", createCall.params["label"])
	}
}

func TestPlaceEmptyPaneTabLabelBlankFallback(t *testing.T) {
	fake := &fakeHerdrCall{}
	ns := workflow.TemplateNamespace{
		Inputs: map[string]any{"branch": "  "},
	}
	paneName := "{{inputs.branch}}"

	label := ResolvePaneLabel(paneName, ns, "launch")

	_, err := PlaceEmptyPane(PlaceOpts{
		Open:  "tab",
		Label: label,
		Deps: RunnerDeps{
			HerdrCall: fake.call,
		},
		Invocation: config.InvocationContext{
			WorkspaceID: "w1",
		},
	})
	if err != nil {
		t.Fatalf("PlaceEmptyPane failed: %v", err)
	}

	createCall := findCall(fake.calls, "tab.create")
	if createCall == nil {
		t.Fatal("tab.create was not called")
	}
	if createCall.params["label"] != "launch" {
		t.Errorf("tab label = %v, want 'launch' (fallback to step ID)", createCall.params["label"])
	}
}

func TestHerdrStepTemplatedEnumBadValue(t *testing.T) {
	fake := &fakeHerdrCall{}
	frame := StepFrame{
		Step: workflow.Step{
			Action: &workflow.HerdrAction{
				Method: "pane.split",
				Params: map[string]any{
					"direction":      "{{inputs.d}}",
					"target_pane_id": "w1:p1",
				},
			},
		},
		Values: workflow.TemplateNamespace{
			Inputs: map[string]any{"d": "sideways"},
		},
		Opts: StepRunOpts{
			Ctx: config.InvocationContext{
				PaneID: "w1:p1",
			},
			Deps: RunnerDeps{
				HerdrCall: fake.call,
			},
		},
	}

	outcome, err := HerdrStep(frame)
	if err != nil {
		t.Fatalf("HerdrStep returned error: %v", err)
	}

	if outcome.OK {
		t.Errorf("HerdrStep.OK = true, want false for bad enum value")
	}

	if !strings.Contains(outcome.Error, "param 'direction' must be one of right, down") {
		t.Errorf("HerdrStep error = %q, want to contain enum validation message", outcome.Error)
	}

	// Make sure that the test does not call pane.split
	splitCalls := slices.ContainsFunc(fake.calls, func(r herdrCallRecord) bool {
		return r.method == "pane.split"
	})
	if splitCalls {
		t.Error("pane.split was called, should not be for bad enum value")
	}
}

func TestHerdrStepTemplatedEnumGoodValue(t *testing.T) {
	fake := &fakeHerdrCall{}
	frame := StepFrame{
		Step: workflow.Step{
			Action: &workflow.HerdrAction{
				Method: "pane.split",
				Params: map[string]any{
					"direction":      "{{inputs.d}}",
					"target_pane_id": "w1:p1",
				},
			},
		},
		Values: workflow.TemplateNamespace{
			Inputs: map[string]any{"d": "right"},
		},
		Opts: StepRunOpts{
			Ctx: config.InvocationContext{
				PaneID: "w1:p1",
			},
			Deps: RunnerDeps{
				HerdrCall: fake.call,
			},
		},
	}

	outcome, err := HerdrStep(frame)
	if err != nil {
		t.Fatalf("HerdrStep returned error: %v", err)
	}

	if !outcome.OK {
		t.Errorf("HerdrStep.OK = false, want true. Error: %v", outcome.Error)
	}

	splitCall := findCall(fake.calls, "pane.split")
	if splitCall == nil {
		t.Fatal("pane.split was not called")
	}

	if splitCall.params["direction"] != "right" {
		t.Errorf("split direction = %v, want right", splitCall.params["direction"])
	}
}

// Find a recorded call by method
func findCall(calls []herdrCallRecord, method string) *herdrCallRecord {
	for i := range calls {
		if calls[i].method == method {
			return &calls[i]
		}
	}
	return nil
}

func TestShellStepPlacedPaneCarriesRunContextEnv(t *testing.T) {
	fake := &fakeHerdrCall{}
	frame := StepFrame{
		Step: workflow.Step{
			ID: "boot",
			Action: &workflow.RunAction{
				Payload:    workflow.RunPayload{Argv: []string{"sh", "-c", "echo hi"}},
				Pane:       &workflow.PaneSpec{Open: "beside", Anchor: "w1:pM"},
				Background: true,
			},
		},
		Values: workflow.TemplateNamespace{Inputs: map[string]any{}},
		Opts: StepRunOpts{
			RunID:    "5da1aa28-f1c3-410f-9cfc-e6ecd75c356e",
			Name:     "ship",
			RepoRoot: "/repo/a",
			Ctx: config.InvocationContext{
				PaneID: "w1:p1", TabID: "w1:t1", WorkspaceID: "w1", Cwd: t.TempDir(),
			},
			Deps: RunnerDeps{HerdrCall: fake.call},
		},
	}
	if _, err := ShellStep(frame); err != nil {
		t.Fatalf("ShellStep returned error: %v", err)
	}
	want := map[string]string{
		"HWF_RUN_ID":        "5da1aa28-f1c3-410f-9cfc-e6ecd75c356e",
		"HWF_WORKFLOW":      "ship",
		"HWF_CHECKOUT_ROOT": "/repo/a",
	}
	found := false
	for _, call := range fake.calls {
		env, ok := call.params["env"].(map[string]string)
		if !ok {
			continue
		}
		found = true
		for key, value := range want {
			if env[key] != value {
				t.Fatalf("%s env[%s] = %q, want %q", call.method, key, env[key], value)
			}
		}
	}
	if !found {
		t.Fatalf("no placement call carried an env map: %+v", fake.calls)
	}
}
