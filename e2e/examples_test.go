package e2e_test

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestBranchCheckCoversCleanChangedExistingAndAvailableOutcomes(t *testing.T) {
	h := newExampleHarness(t)
	scenarios := []struct {
		inputs map[string]string
		env    map[string]string
		title  string
	}{
		{
			inputs: map[string]string{"mode": "status"},
			env:    map[string]string{"HWF_E2E_GIT_DIRTY": "0"},
			title:  "working tree clean",
		},
		{
			inputs: map[string]string{"mode": "status"},
			env:    map[string]string{"HWF_E2E_GIT_DIRTY": "1"},
			title:  "working tree changed",
		},
		{
			inputs: map[string]string{"mode": "branch", "branch": "main"},
			env:    map[string]string{"HWF_E2E_BRANCH_EXISTS": "1"},
			title:  "branch exists",
		},
		{
			inputs: map[string]string{"mode": "branch", "branch": "new-feature"},
			env:    map[string]string{"HWF_E2E_BRANCH_EXISTS": "0"},
			title:  "branch available",
		},
	}

	for _, scenario := range scenarios {
		calls := runOK(t, h, "branch-check", scenario.inputs, scenario.env)
		got := make([]any, 0, len(notifications(calls)))
		for _, params := range notifications(calls) {
			got = append(got, params["title"])
		}
		if len(got) != 1 || got[0] != scenario.title {
			t.Fatalf("scenario %+v titles = %v want [%q]", scenario.inputs, got, scenario.title)
		}
	}
}

func TestPromptEnhanceUsesConfiguredCustomAgentAndPlatformClipboard(t *testing.T) {
	h := newExampleHarness(t)
	calls := runOK(t, h, "prompt-enhance", map[string]string{"target": "deterministic", "text": "fix it"}, map[string]string{"WAYLAND_DISPLAY": "wayland-e2e"})

	expected := "wl-copy"
	if runtime.GOOS == "darwin" {
		expected = "pbcopy"
	}
	clip, err := os.ReadFile(h.clipboard)
	if err != nil {
		t.Fatal(err)
	}
	if string(clip) != expected+":refined prompt" {
		t.Fatalf("clipboard = %q want %q", clip, expected+":refined prompt")
	}
	var startParams map[string]any
	for _, call := range calls {
		if call.Method == "agent.start" {
			startParams = call.Params
			break
		}
	}
	if startParams == nil || startParams["kind"] != "custom" {
		t.Fatalf("agent.start params = %#v", startParams)
	}
	if got := titles(calls); len(got) != 1 || got[0] != "enhancing prompt" {
		t.Fatalf("titles = %v", got)
	}
	foundClose := false
	for _, call := range calls {
		if call.Method == "pane.close" {
			foundClose = true
			break
		}
	}
	if !foundClose {
		t.Fatal("expected pane.close")
	}
}

func TestPromptEnhanceFallsBackToXclipWhenNoWaylandDisplayIsSet(t *testing.T) {
	if runtime.GOOS == "darwin" {
		t.Skip("macOS never reaches this branch: the workflow guards it on context.platform")
	}
	h := newExampleHarness(t)
	calls := runOK(t, h, "prompt-enhance", map[string]string{"target": "deterministic", "text": "fix it"}, map[string]string{"WAYLAND_DISPLAY": ""})
	clip, err := os.ReadFile(h.clipboard)
	if err != nil {
		t.Fatal(err)
	}
	if string(clip) != "xclip:refined prompt" {
		t.Fatalf("clipboard = %q", clip)
	}
	if got := titles(calls); len(got) != 1 || got[0] != "enhancing prompt" {
		t.Fatalf("titles = %v", got)
	}
}

func TestHandoffPreservesTargetAndCleansUpAtSelectedGranularity(t *testing.T) {
	h := newExampleHarness(t)
	for _, placement := range []string{"tab", "beside", "below"} {
		for _, closeSource := range []string{"keep", "close"} {
			calls := runOK(t, h, "handoff", map[string]string{
				"target":       "deterministic",
				"focus":        "",
				"placement":    placement,
				"close_source": closeSource,
			}, nil)

			starts := filterCalls(calls, "agent.start")
			if len(starts) != 2 {
				t.Fatalf("placement=%s close=%s agent.start count = %d", placement, closeSource, len(starts))
			}
			handoff, err := os.ReadFile(filepath.Join(h.repoRoot, ".hwf", "tmp", "handoff.md"))
			if err != nil {
				t.Fatal(err)
			}
			if string(handoff) != "deterministic handoff" {
				t.Fatalf("handoff = %q", handoff)
			}
			targetPane := fmtString(starts[1].Params["pane_id"])
			sourcePaneCloses := filterCallsWhere(calls, "pane.close", func(p map[string]any) bool {
				return fmtString(p["pane_id"]) == "w1:p1"
			})
			sourceTabCloses := filterCallsWhere(calls, "tab.close", func(p map[string]any) bool {
				return fmtString(p["tab_id"]) == "w1:t1"
			})
			targetClosed := false
			for _, call := range calls {
				if call.Method == "pane.close" && fmtString(call.Params["pane_id"]) == targetPane {
					targetClosed = true
				}
			}
			if targetClosed {
				t.Fatalf("target pane %s was closed", targetPane)
			}
			assertHandoffCloseBehavior(t, placement, closeSource, sourcePaneCloses, sourceTabCloses)
			assertHandoffPlacementCalls(t, calls, placement)
		}
	}
}

func assertHandoffCloseBehavior(t *testing.T, placement, closeSource string, sourcePaneCloses, sourceTabCloses []rpcCall) {
	t.Helper()
	if closeSource == "keep" {
		if len(sourcePaneCloses) != 0 || len(sourceTabCloses) != 0 {
			t.Fatalf("keep: pane closes=%d tab closes=%d", len(sourcePaneCloses), len(sourceTabCloses))
		}
		return
	}
	if placement == "tab" {
		if len(sourceTabCloses) != 1 || len(sourcePaneCloses) != 0 {
			t.Fatalf("tab close: pane closes=%d tab closes=%d", len(sourcePaneCloses), len(sourceTabCloses))
		}
		return
	}
	if len(sourcePaneCloses) != 1 || len(sourceTabCloses) != 0 {
		t.Fatalf("%s close: pane closes=%d tab closes=%d", placement, len(sourcePaneCloses), len(sourceTabCloses))
	}
}

func assertHandoffPlacementCalls(t *testing.T, calls []rpcCall, placement string) {
	t.Helper()
	if placement == "tab" {
		if len(filterCalls(calls, "tab.create")) != 2 {
			t.Fatal("expected two tab.create calls")
		}
		return
	}
	expectedDirection := "right"
	if placement == "below" {
		expectedDirection = "down"
	}
	for _, call := range calls {
		if call.Method == "pane.split" &&
			fmtString(call.Params["direction"]) == expectedDirection &&
			fmtString(call.Params["target_pane_id"]) == "w1:p1" {
			return
		}
	}
	t.Fatalf("missing pane.split direction=%s", expectedDirection)
}

func TestWorktreeCreateRunsFullLayoutWithPerPaneAgentName(t *testing.T) {
	h := newExampleHarness(t)
	calls := runOK(t, h, "worktree", map[string]string{
		"mode": "create", "ref": "main", "branch": "feat-x",
	}, nil)
	created := findCall(calls, "worktree.create")
	if created == nil {
		t.Fatal("missing worktree.create")
	}
	wantCwd := repoRealpath(t, h.repoRoot)
	if fmtString(created.Params["cwd"]) != wantCwd ||
		fmtString(created.Params["branch"]) != "feat-x" ||
		fmtString(created.Params["base"]) != "main" ||
		fmtString(created.Params["label"]) != "feat-x" ||
		created.Params["focus"] != true {
		t.Fatalf("worktree.create params = %#v", created.Params)
	}
	rename := findCall(calls, "tab.rename")
	if rename == nil || fmtString(rename.Params["label"]) != "work" {
		t.Fatalf("tab.rename = %#v", rename)
	}
	started := findCall(calls, "agent.start")
	if started == nil || fmtString(started.Params["kind"]) != "claude" {
		t.Fatalf("agent.start = %#v", started)
	}
	paneID := fmtString(started.Params["pane_id"])
	wantName := sanitizeAgentName("claude-" + paneID)
	if fmtString(started.Params["name"]) != wantName {
		t.Fatalf("agent name = %q want %q", started.Params["name"], wantName)
	}
	if findCall(calls, "tab.focus") == nil {
		t.Fatal("missing tab.focus")
	}
	if got := titles(calls); len(got) != 0 {
		t.Fatalf("titles = %v", got)
	}
}

func TestWorktreeOpenTargetsExistingBranchThroughSameLayout(t *testing.T) {
	h := newExampleHarness(t)
	calls := runOK(t, h, "worktree", map[string]string{
		"mode": "open", "worktree": "feature-seed",
	}, nil)
	opened := findCall(calls, "worktree.open")
	if opened == nil {
		t.Fatal("missing worktree.open")
	}
	wantCwd := repoRealpath(t, h.repoRoot)
	if fmtString(opened.Params["cwd"]) != wantCwd ||
		fmtString(opened.Params["branch"]) != "feature-seed" ||
		fmtString(opened.Params["label"]) != "feature-seed" ||
		opened.Params["focus"] != true {
		t.Fatalf("worktree.open params = %#v", opened.Params)
	}
	if findCall(calls, "worktree.create") != nil {
		t.Fatal("unexpected worktree.create")
	}
	if got := titles(calls); len(got) != 0 {
		t.Fatalf("titles = %v", got)
	}
}

func TestReviewGateNotifiesOnApproveAndFailsRunOnReject(t *testing.T) {
	h := newExampleHarness(t)
	approved := runOK(t, h, "review-gate", map[string]string{"reviewer": "deterministic"}, map[string]string{"HWF_E2E_GIT_DIRTY": "1", "HWF_E2E_REVIEW_VERDICT": "APPROVE"})
	if got := titles(approved); len(got) != 1 || got[0] != "review approved" {
		t.Fatalf("approved titles = %v", got)
	}
	if findCall(approved, "pane.close") == nil {
		t.Fatal("expected pane.close on approve")
	}

	rejected, err := h.run(
		"review-gate",
		map[string]string{"reviewer": "deterministic"},
		map[string]string{"HWF_E2E_GIT_DIRTY": "1", "HWF_E2E_REVIEW_VERDICT": "REJECT"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if rejected.ExitCode == 0 {
		t.Fatal("expected non-zero exit on reject")
	}
	if !strings.Contains(rejected.Stderr, "one finding, reported above") {
		t.Fatalf("stderr = %q", rejected.Stderr)
	}
	if len(titles(rejected.Calls)) != 0 {
		t.Fatalf("reject titles = %v", titles(rejected.Calls))
	}
}

func TestReviewGateSkipsReviewerWhenDiffIsEmpty(t *testing.T) {
	h := newExampleHarness(t)
	calls := runOK(t, h, "review-gate", map[string]string{"reviewer": "deterministic"}, map[string]string{"HWF_E2E_GIT_DIRTY": "0"})
	if got := titles(calls); len(got) != 1 || got[0] != "nothing to review" {
		t.Fatalf("titles = %v", got)
	}
	if findCall(calls, "agent.start") != nil {
		t.Fatal("unexpected agent.start")
	}
}

func TestAdversarialReviseRunsRevisionStepOnlyOnReviseVerdict(t *testing.T) {
	h := newExampleHarness(t)
	scenarios := []struct {
		verdict string
		starts  int
		title   string
	}{
		{verdict: "APPROVE", starts: 2, title: "proposal approved"},
		{verdict: "REVISE", starts: 3, title: "proposal revised"},
	}
	for _, scenario := range scenarios {
		calls := runOK(t, h, "adversarial-revise", map[string]string{"task": "ship a thing", "author": "deterministic", "critic": "deterministic"}, map[string]string{"HWF_E2E_CRITIQUE_VERDICT": scenario.verdict})
		if len(filterCalls(calls, "agent.start")) != scenario.starts {
			t.Fatalf("verdict=%s starts = %d want %d", scenario.verdict, len(filterCalls(calls, "agent.start")), scenario.starts)
		}
		if got := titles(calls); len(got) != 1 || got[0] != scenario.title {
			t.Fatalf("verdict=%s titles = %v", scenario.verdict, got)
		}
	}
}

func TestRemoteBranchLogResolvesBranchChoiceFromChosenRemote(t *testing.T) {
	h := newExampleHarness(t)
	for _, remote := range []string{"origin", "upstream"} {
		calls := runOK(t, h, "remote-branch-log", map[string]string{
			"remote": remote,
			"branch": remote + "/release",
		}, nil)
		shown := notifications(calls)
		if len(shown) != 1 {
			t.Fatalf("remote=%s notifications = %d", remote, len(shown))
		}
		if fmtString(shown[0]["title"]) != "recent commits on "+remote+"/release" {
			t.Fatalf("title = %v", shown[0]["title"])
		}
		if body, ok := shown[0]["body"].(string); !ok || body != "abc1234 seed commit on "+remote+"/release\n" {
			t.Fatalf("body = %q", shown[0]["body"])
		}
		if fmtString(shown[0]["sound"]) != "done" {
			t.Fatalf("sound = %v", shown[0]["sound"])
		}
	}

	crossed, err := h.run("remote-branch-log", map[string]string{
		"remote": "origin",
		"branch": "upstream/release",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if crossed.ExitCode == 0 {
		t.Fatal("expected failure for crossed remote/branch")
	}
	if !strings.Contains(crossed.Stderr, "must be one of: origin/main, origin/release") {
		t.Fatalf("stderr = %q", crossed.Stderr)
	}
}

func TestWorktreeOpenSkipsAgentStartWhenReopenedPaneAlreadyHasOne(t *testing.T) {
	h := newExampleHarness(t)
	calls := runOK(t, h, "worktree", map[string]string{"mode": "open", "worktree": "feature-seed"}, map[string]string{"HWF_E2E_AGENT_ON_OPEN": "1"})
	if findCall(calls, "worktree.open") == nil {
		t.Fatal("missing worktree.open")
	}
	if len(filterCalls(calls, "agent.start")) != 0 {
		t.Fatal("unexpected agent.start")
	}
	if findCall(calls, "tab.focus") == nil {
		t.Fatal("missing tab.focus")
	}
	if got := titles(calls); len(got) != 0 {
		t.Fatalf("titles = %v", got)
	}
}

func TestWorktreeDeleteRemovesCheckoutAndReportsBranchOutcome(t *testing.T) {
	h := newExampleHarness(t)
	scenarios := []struct {
		scope string
		env   map[string]string
		body  string
	}{
		{
			scope: "worktree-only",
			env:   map[string]string{},
			body:  "removed the feature-seed worktree; branch kept",
		},
		{
			scope: "worktree-and-branch",
			env:   map[string]string{},
			body:  "removed the feature-seed worktree and its branch",
		},
		{
			scope: "worktree-and-branch",
			env:   map[string]string{"HWF_E2E_BRANCH_UNMERGED": "1"},
			body:  "removed the feature-seed worktree; branch kept, it is not merged (git branch -D feature-seed)",
		},
	}
	for _, scenario := range scenarios {
		calls := runOK(t, h, "worktree", map[string]string{
			"mode": "delete", "worktree": "feature-seed", "scope": scenario.scope,
		}, scenario.env)
		if findCall(calls, "worktree.create") != nil {
			t.Fatal("unexpected worktree.create")
		}
		shown := notifications(calls)
		if len(shown) != 1 {
			t.Fatalf("scope=%s notifications = %d", scenario.scope, len(shown))
		}
		if fmtString(shown[0]["title"]) != "Worktree deleted" {
			t.Fatalf("title = %v", shown[0]["title"])
		}
		if body, ok := shown[0]["body"].(string); !ok || body != scenario.body {
			t.Fatalf("body = %q want %q", shown[0]["body"], scenario.body)
		}
	}
}

func filterCalls(calls []rpcCall, method string) []rpcCall {
	out := make([]rpcCall, 0)
	for _, call := range calls {
		if call.Method == method {
			out = append(out, call)
		}
	}
	return out
}

func filterCallsWhere(calls []rpcCall, method string, pred func(map[string]any) bool) []rpcCall {
	out := make([]rpcCall, 0)
	for _, call := range calls {
		if call.Method == method && pred(call.Params) {
			out = append(out, call)
		}
	}
	return out
}

func findCall(calls []rpcCall, method string) *rpcCall {
	for i := range calls {
		if calls[i].Method == method {
			return &calls[i]
		}
	}
	return nil
}

func fmtString(v any) string {
	if v == nil {
		return ""
	}
	return strings.TrimSpace(strings.ReplaceAll(fmt.Sprint(v), "\n", ""))
}

func sanitizeAgentName(name string) string {
	var b strings.Builder
	for _, r := range name {
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	return b.String()
}
