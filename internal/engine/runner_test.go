package engine

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

const fakeRunID = "00000000-0000-4000-8000-000000000001"

func runnerBaseConfig() config.Config {
	return config.Config{
		Profiles:       map[string]config.Profile{"claude": {Kind: "claude"}},
		DefaultProfile: "claude",
	}
}

func writeRunnerWorkflow(t *testing.T, root, name, body string) {
	t.Helper()
	dir := filepath.Join(root, ".hwf", "workflows")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name+".yaml"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeRunnerWorkflows(t *testing.T, root string, bodies map[string]string) {
	t.Helper()
	for name, body := range bodies {
		writeRunnerWorkflow(t, root, name, body)
	}
}

type fakeRecorderCall struct {
	kind        string
	outcomeKind StepOutcomeKind
	label       string
	phase       StepPhase
	status      RunTerminalStatus
}

type fakeRecorder struct {
	runID             string
	calls             []fakeRecorderCall
	stepFinishedCalls []fakeRecorderCall
	finishedCalls     []fakeRecorderCall
	finishedExtras    []*RecorderFinishExtras
}

func newFakeRecorder() *fakeRecorder {
	return &fakeRecorder{runID: fakeRunID}
}

func (r *fakeRecorder) RunID() string { return r.runID }

func (r *fakeRecorder) Child(scope RecorderScope) Recorder { return r }

func (r *fakeRecorder) StepStarted(step workflow.Step, ordinal, total int, label string, phase StepPhase) error {
	r.calls = append(r.calls, fakeRecorderCall{kind: "stepStarted", label: label, phase: phase})
	return nil
}

func (r *fakeRecorder) StepFinished(step workflow.Step, ordinal, total int, label string, kind StepOutcomeKind, outcome *RecorderOutcome, phase StepPhase) error {
	c := fakeRecorderCall{kind: "stepFinished", outcomeKind: kind, label: label, phase: phase}
	r.calls = append(r.calls, c)
	r.stepFinishedCalls = append(r.stepFinishedCalls, c)
	return nil
}

func (r *fakeRecorder) Finished(status RunTerminalStatus, extras *RecorderFinishExtras) error {
	c := fakeRecorderCall{kind: "finished", status: status}
	r.calls = append(r.calls, c)
	r.finishedCalls = append(r.finishedCalls, c)
	r.finishedExtras = append(r.finishedExtras, extras)
	return nil
}

func (r *fakeRecorder) Dispose() {
	r.calls = append(r.calls, fakeRecorderCall{kind: "dispose"})
}

type runnerHarness struct {
	calls []herdrCallRecord
	notes []string
	fake  *fakeHerdrCall
}

func newRunnerHarness() *runnerHarness {
	return &runnerHarness{fake: &fakeHerdrCall{}}
}

func (h *runnerHarness) herdrCall(method string, params map[string]any) (map[string]any, error) {
	h.calls = append(h.calls, herdrCallRecord{method: method, params: params})
	return h.fake.defaultResponse(method, params), nil
}

func (h *runnerHarness) notificationShow(title string, body *string) error {
	b := ""
	if body != nil {
		b = *body
	}
	h.notes = append(h.notes, title+"|"+b)
	return nil
}

func (h *runnerHarness) hasMethod(name string) bool {
	return slices.ContainsFunc(h.calls, func(c herdrCallRecord) bool {
		return c.method == name
	})
}

func runnerDeps(h *runnerHarness) RunnerDeps {
	deps := RunnerDeps{
		Sleep: func(time.Duration) {},
		Now:   func() time.Time { return time.Unix(0, 0).UTC() },
	}
	if h != nil {
		deps.HerdrCall = h.herdrCall
		deps.NotificationShow = h.notificationShow
	}
	return deps
}

func formatProgressLine(i, n int, label string, outcome *ProgressOutcome) string {
	suffix := ""
	if outcome != nil && *outcome != ProgressOk {
		suffix = " " + string(*outcome)
	}
	return fmt.Sprintf("[%d/%d] %s%s", i, n, label, suffix)
}

func formatProgressEvent(i, n int, label string, outcome *ProgressOutcome) string {
	o := string(ProgressOk)
	if outcome != nil {
		o = string(*outcome)
	}
	return fmt.Sprintf("%d/%d:%s:%s", i, n, label, o)
}

func TestRunWorkflowLocalArgvEnvHandoff(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
steps:
  - id: probe
    run: [sh, -c, "printf hi; printf err >&2"]
  - id: next
    run: [sh, -c, 'printf "%s" "$MSG" > handoff.txt']
    env: { MSG: "{{steps.probe.stdout}}" }
`)
	h := newRunnerHarness()
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root, WorkspaceID: "w1", TabID: "w1:t1", PaneID: "w1:p1"},
		Deps:     runnerDeps(h),
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if !result.OK {
		t.Fatalf("result.OK = false, want true; Error = %q", result.Error)
	}
	got, readErr := os.ReadFile(filepath.Join(root, "handoff.txt"))
	if readErr != nil {
		t.Fatalf("read handoff.txt: %v", readErr)
	}
	if string(got) != "hi" {
		t.Fatalf("handoff.txt = %q, want %q", got, "hi")
	}
}

func TestRunWorkflowShellRejectsReservedHWFEnv(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
steps:
  - run: [echo, hi]
    env: { HWF_name: x }
`)
	h := newRunnerHarness()
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Deps:     runnerDeps(h),
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if result.OK {
		t.Fatal("result.OK = true, want false")
	}
	if !strings.Contains(result.Error, "reserved HWF_") {
		t.Fatalf("Error = %q, want to contain %q", result.Error, "reserved HWF_")
	}
}

func TestRunWorkflowWhenSkipContinuesWithoutRecovery(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
on_failure:
  herdr: notification.show
  params: { title: recovered }
steps:
  - id: flag
    run: [sh, -c, "printf ''"]
  - run: [sh, -c, "printf ran"]
    when: "{{steps.flag.stdout}}"
  - run: [sh, -c, "printf done"]
`)
	h := newRunnerHarness()
	recorder := newFakeRecorder()
	var outcomes []string
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Deps:     runnerDeps(h),
		Recorder: recorder,
		OnProgress: func(_step, _total int, label string, outcome *ProgressOutcome) {
			o := "start"
			if outcome != nil {
				o = string(*outcome)
			}
			outcomes = append(outcomes, label+":"+o)
		},
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if !result.OK {
		t.Fatalf("result.OK = false, want true; Error = %q", result.Error)
	}
	if !slices.ContainsFunc(outcomes, func(o string) bool { return strings.Contains(o, "skip") }) {
		t.Fatalf("outcomes = %#v, want some entry containing skip", outcomes)
	}
	if !slices.ContainsFunc(recorder.stepFinishedCalls, func(c fakeRecorderCall) bool {
		return c.outcomeKind == OutcomeSkipped
	}) {
		t.Fatalf("stepFinishedCalls = %#v, want OutcomeSkipped", recorder.stepFinishedCalls)
	}
	if h.hasMethod("notification.show") {
		t.Fatal("notification.show was called; recovery must not run on skip")
	}
	if len(h.notes) != 0 {
		t.Fatalf("notes = %#v, want empty", h.notes)
	}
}

func TestRunWorkflowNestedWhenFalseKeepsParentAndFinishes(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflows(t, root, map[string]string{
		"child": `version: v1alpha1
steps:
  - id: skipme
    run: [printf, no]
    when: '{{context.platform}} == "windows"'
`,
		"parent": `version: v1alpha1
steps:
  - id: wrap
    workflow: child
`,
	})
	h := newRunnerHarness()
	recorder := newFakeRecorder()
	result, err := RunWorkflow(RunOptions{
		Name:     "parent",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Deps:     runnerDeps(h),
		Recorder: recorder,
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if !result.OK {
		t.Fatalf("result.OK = false, want true; Error = %q", result.Error)
	}
	if !slices.ContainsFunc(recorder.stepFinishedCalls, func(c fakeRecorderCall) bool {
		return c.label == "skipme" && c.outcomeKind == OutcomeSkipped
	}) {
		t.Fatalf("stepFinishedCalls = %#v, want skipme skipped", recorder.stepFinishedCalls)
	}
	if !slices.ContainsFunc(recorder.stepFinishedCalls, func(c fakeRecorderCall) bool {
		return c.label == "wrap" && c.outcomeKind == OutcomeSucceeded
	}) {
		t.Fatalf("stepFinishedCalls = %#v, want wrap succeeded", recorder.stepFinishedCalls)
	}
	if len(recorder.finishedCalls) != 1 || recorder.finishedCalls[0].status != StatusSucceeded {
		t.Fatalf("finishedCalls = %#v, want one succeeded terminal", recorder.finishedCalls)
	}
}

func TestRunWorkflowAutomaticFailureNotificationOmitsStderr(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
steps:
  - run: [sh, -c, "printf 'secret-stderr' >&2; exit 3"]
`)
	h := newRunnerHarness()
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Deps:     runnerDeps(h),
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if result.OK {
		t.Fatal("result.OK = true, want false")
	}
	if !strings.Contains(result.Error, "secret-stderr") {
		t.Fatalf("Error = %q, want to contain %q", result.Error, "secret-stderr")
	}
	if len(h.notes) != 1 {
		t.Fatalf("notes length = %d, want 1; notes = %#v", len(h.notes), h.notes)
	}
	wantNote := "herdr-workflows: m failed|Step 1 failed; inspect the terminal or run history for details."
	if h.notes[0] != wantNote {
		t.Fatalf("notes[0] = %q, want %q", h.notes[0], wantNote)
	}
	if strings.Contains(h.notes[0], "secret-stderr") {
		t.Fatalf("note must omit command stderr, got %q", h.notes[0])
	}
}

func TestRunWorkflowContinueOnErrorSuppressesRecovery(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
on_failure:
  herdr: notification.show
  params: { title: recovered }
steps:
  - id: probe
    run: [sh, -c, "exit 2"]
    continue_on_error: true
  - run: [sh, -c, "touch continued"]
`)
	h := newRunnerHarness()
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Deps:     runnerDeps(h),
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if result.OK {
		t.Fatal("result.OK = true, want false")
	}
	if _, statErr := os.Stat(filepath.Join(root, "continued")); statErr != nil {
		t.Fatalf("continued file missing: %v", statErr)
	}
	if h.hasMethod("notification.show") {
		t.Fatal("notification.show was called; recovery must not run with continue_on_error")
	}
}

func TestRunWorkflowRetryCountsTotalAttempts(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
steps:
  - run: [sh, -c, "test -f marker || (touch marker; exit 1)"]
    retry: { attempts: 2 }
`)
	h := newRunnerHarness()
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Deps:     runnerDeps(h),
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if !result.OK {
		t.Fatalf("result.OK = false, want true; Error = %q", result.Error)
	}
	if _, statErr := os.Stat(filepath.Join(root, "marker")); statErr != nil {
		t.Fatalf("marker file missing: %v", statErr)
	}
}

func TestRunWorkflowProgressReportsOutcomeIncludingSkip(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
inputs:
  flag:
    type: text
    default: ""
steps:
  - id: go
    run: [printf, ok]
  - id: skipme
    run: [printf, no]
    when: "{{inputs.flag}}"
`)
	h := newRunnerHarness()
	var lines []string
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Deps:     runnerDeps(h),
		Recorder: newFakeRecorder(),
		OnProgress: func(i, n int, label string, outcome *ProgressOutcome) {
			lines = append(lines, formatProgressLine(i, n, label, outcome))
		},
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if !result.OK {
		t.Fatalf("result.OK = false, want true; Error = %q", result.Error)
	}
	want := []string{"[1/2] go start", "[1/2] go", "[2/2] skipme skip"}
	if !slices.Equal(lines, want) {
		t.Fatalf("lines = %#v, want %#v", lines, want)
	}
}

func TestRunWorkflowCLIProgressEmitsStartAndOutcome(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
steps:
  - run: [sh, -c, "printf a"]
  - run: [sh, -c, "printf b"]
`)
	h := newRunnerHarness()
	var events []string
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Deps:     runnerDeps(h),
		Recorder: newFakeRecorder(),
		OnProgress: func(i, n int, label string, outcome *ProgressOutcome) {
			events = append(events, formatProgressEvent(i, n, label, outcome))
		},
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if !result.OK {
		t.Fatalf("result.OK = false, want true; Error = %q", result.Error)
	}
	want := []string{
		"1/2:run: sh -c printf a:start",
		"1/2:run: sh -c printf a:ok",
		"2/2:run: sh -c printf b:start",
		"2/2:run: sh -c printf b:ok",
	}
	if !slices.Equal(events, want) {
		t.Fatalf("events = %#v, want %#v", events, want)
	}
}

// Go-only: cycle-5 decision. Recorder is required. There is no history substitute.
func TestNilRecorderRequired(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
steps:
  - run: [sh, -c, "printf ok"]
`)
	h := newRunnerHarness()
	_, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Deps:     runnerDeps(h),
		Recorder: nil,
	})
	if err == nil {
		t.Fatal("RunWorkflow error = nil, want non-nil (recorder required)")
	}
	msg := err.Error()
	if !strings.Contains(strings.ToLower(msg), "recorder") {
		t.Fatalf("error = %q, want to name recorder", msg)
	}
	if !strings.Contains(strings.ToLower(msg), "required") {
		t.Fatalf("error = %q, want to name that a recorder is required", msg)
	}
}

func TestRunWorkflowRejectsNonCanonicalRunID(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
steps:
  - run: [sh, -c, "printf ok"]
`)
	h := newRunnerHarness()
	rec := newFakeRecorder()
	rec.runID = "not-a-uuid"
	_, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root, WorkspaceID: "w1", TabID: "w1:t1", PaneID: "w1:p1"},
		Deps:     runnerDeps(h),
		Recorder: rec,
	})
	if err == nil {
		t.Fatal("RunWorkflow error = nil, want non-canonical run id rejection")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "run id") {
		t.Fatalf("error = %q, want to name run id", err.Error())
	}
}

func notifyShowCalls(calls []herdrCallRecord) []herdrCallRecord {
	var out []herdrCallRecord
	for _, c := range calls {
		if c.method == "notification.show" {
			out = append(out, c)
		}
	}
	return out
}

func stringParam(t *testing.T, params map[string]any, key string) string {
	t.Helper()
	v, ok := params[key]
	if !ok {
		t.Fatalf("params missing %q; params = %#v", key, params)
	}
	s, ok := v.(string)
	if !ok {
		t.Fatalf("params[%q] type %T, want string; value = %#v", key, v, v)
	}
	return s
}

func TestRunWorkflowContinueOnErrorCannotTolerateCommandTimeout(t *testing.T) {
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
on_failure:
  herdr: notification.show
  params: { title: recovered }
steps:
  - run: [sh, -c, "sleep 1"]
    timeout: 50ms
    continue_on_error: true
  - run: [sh, -c, "touch should-not-run"]
`)
	h := newRunnerHarness()
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Deps:     runnerDeps(h),
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if result.OK {
		t.Fatal("result.OK = true, want false")
	}
	if _, statErr := os.Stat(filepath.Join(root, "should-not-run")); !os.IsNotExist(statErr) {
		t.Fatalf("should-not-run: stat err = %v, want not exist", statErr)
	}
	if !h.hasMethod("notification.show") {
		t.Fatal("notification.show was not called; recovery must run for hard timeout")
	}
}

func TestRunWorkflowOnFailureRunsOnceWithContextError(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
on_failure:
  herdr: notification.show
  params: { title: "{{context.error.workflow}}", body: "{{context.error.message}}" }
steps:
  - run: [sh, -c, "printf boom >&2; exit 1"]
`)
	h := newRunnerHarness()
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Deps:     runnerDeps(h),
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if result.OK {
		t.Fatal("result.OK = true, want false")
	}
	notify := notifyShowCalls(h.calls)
	if len(notify) != 1 {
		t.Fatalf("notification.show calls = %d, want 1; calls = %#v", len(notify), notify)
	}
	if title := stringParam(t, notify[0].params, "title"); title != "m" {
		t.Fatalf("title = %q, want %q", title, "m")
	}
	if body := stringParam(t, notify[0].params, "body"); body != "boom" {
		t.Fatalf("body = %q, want %q", body, "boom")
	}
}

func TestRunWorkflowAgentFailureDetailsReachContextErrorInRecovery(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
on_failure:
  herdr: notification.show
  params:
    title: "{{context.error.details.profile}}"
    body: "{{context.error.details.kind}}|{{context.error.details.pane_id}}|{{context.error.details.tab_id}}|{{context.error.details.workspace_id}}"
steps:
  - id: review
    agent: summarize
    using: claude
    pane: { open: beside }
`)
	ah := newAgentHarness(t, root)
	ah.writeManagedResponse = false
	deps := RunnerDeps{
		HerdrCall:        ah.call,
		NotificationShow: ah.notificationShow,
		AgentStatus:      ah.status,
		AgentInfo:        ah.info,
		PaneClose:        ah.paneClose,
		Sleep:            ah.clock.Sleep,
		Now:              ah.clock.Now,
		ResponseDir:      &ah.responseDir,
	}
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root, WorkspaceID: "w1", TabID: "w1:t1", PaneID: "w1:p1"},
		Deps:     deps,
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if result.OK {
		t.Fatal("result.OK = true, want false")
	}
	notify := notifyShowCalls(ah.calls)
	if len(notify) != 1 {
		t.Fatalf("notification.show calls = %d, want 1; calls = %#v", len(notify), notify)
	}
	if title := stringParam(t, notify[0].params, "title"); title != "claude" {
		t.Fatalf("title = %q, want %q", title, "claude")
	}
	wantBody := "claude|w1:p3|w1:t1|w1"
	if body := stringParam(t, notify[0].params, "body"); body != wantBody {
		t.Fatalf("body = %q, want %q", body, wantBody)
	}
}

func TestRunWorkflowHerdrFailureDetailsIncludeMethodAndReasonInRecovery(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
on_failure:
  herdr: notification.show
  params:
    title: "{{context.error.details.method}}"
    body: "{{context.error.details.reason}}"
steps:
  - herdr: pane.focus
    params: { pane_id: "missing-pane" }
`)
	h := newRunnerHarness()
	base := h.herdrCall
	deps := runnerDeps(h)
	deps.HerdrCall = func(method string, params map[string]any) (map[string]any, error) {
		if method == "pane.focus" {
			h.calls = append(h.calls, herdrCallRecord{method: method, params: params})
			return nil, &host.HerdrError{Code: "not_found", Msg: "pane not found: missing-pane"}
		}
		return base(method, params)
	}
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Deps:     deps,
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if result.OK {
		t.Fatal("result.OK = true, want false")
	}
	notify := notifyShowCalls(h.calls)
	if len(notify) != 1 {
		t.Fatalf("notification.show calls = %d, want 1; calls = %#v", len(notify), notify)
	}
	if title := stringParam(t, notify[0].params, "title"); title != "pane.focus" {
		t.Fatalf("title = %q, want %q", title, "pane.focus")
	}
	body := stringParam(t, notify[0].params, "body")
	if !strings.Contains(body, "pane not found: missing-pane") {
		t.Fatalf("body = %q, want to contain %q", body, "pane not found: missing-pane")
	}
}

func TestRunWorkflowTransportLossSkipsOnFailure(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
on_failure:
  herdr: notification.show
  params: { title: should-not-run }
steps:
  - herdr: notification.show
    params: { title: go }
`)
	h := newRunnerHarness()
	deps := runnerDeps(h)
	deps.HerdrCall = func(method string, params map[string]any) (map[string]any, error) {
		if method == "notification.show" {
			return nil, &host.HerdrError{Code: "closed", Msg: "notification.show: socket closed before response"}
		}
		return h.fake.defaultResponse(method, params), nil
	}
	recorder := newFakeRecorder()
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Deps:     deps,
		Recorder: recorder,
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if result.OK {
		t.Fatal("result.OK = true, want false")
	}
	if !result.CoordinationLost {
		t.Fatal("CoordinationLost = false, want true")
	}
	if !strings.Contains(result.Error, "may still be active") {
		t.Fatalf("Error = %q, want to contain %q", result.Error, "may still be active")
	}
	notify := notifyShowCalls(h.calls)
	if len(notify) != 0 {
		t.Fatalf("notification.show calls = %d, want 0; calls = %#v", len(notify), notify)
	}
	if slices.ContainsFunc(h.calls, func(c herdrCallRecord) bool {
		title, _ := c.params["title"].(string)
		return c.method == "notification.show" && title == "should-not-run"
	}) {
		t.Fatal("recovery title should-not-run was sent")
	}
	if !slices.ContainsFunc(recorder.finishedCalls, func(c fakeRecorderCall) bool {
		return c.status == StatusInterrupted
	}) {
		t.Fatalf("finishedCalls = %#v, want StatusInterrupted", recorder.finishedCalls)
	}
}

func TestRunWorkflowTransportLossCodesAreCoordinationLoss(t *testing.T) {
	t.Parallel()
	for _, code := range []string{"closed", "no_socket", "unreachable"} {
		t.Run(code, func(t *testing.T) {
			t.Parallel()
			root := t.TempDir()
			writeRunnerWorkflow(t, root, "m", `version: v1alpha1
on_failure:
  herdr: notification.show
  params: { title: should-not-run }
steps:
  - herdr: notification.show
    params: { title: go }
`)
			h := newRunnerHarness()
			deps := runnerDeps(h)
			deps.HerdrCall = func(method string, params map[string]any) (map[string]any, error) {
				if method == "notification.show" {
					return nil, &host.HerdrError{Code: code, Msg: method + ": injected " + code}
				}
				return h.fake.defaultResponse(method, params), nil
			}
			result, err := RunWorkflow(RunOptions{
				Name:     "m",
				RepoRoot: root,
				Config:   runnerBaseConfig(),
				Ctx:      config.InvocationContext{Selection: "", Cwd: root},
				Deps:     deps,
				Recorder: newFakeRecorder(),
			})
			if err != nil {
				t.Fatalf("RunWorkflow: %v", err)
			}
			if result.OK {
				t.Fatal("result.OK = true, want false")
			}
			if !result.CoordinationLost {
				t.Fatal("CoordinationLost = false, want true")
			}
			if !strings.Contains(result.Error, "may still be active") {
				t.Fatalf("Error = %q, want to contain %q", result.Error, "may still be active")
			}
			if slices.ContainsFunc(h.calls, func(c herdrCallRecord) bool {
				title, _ := c.params["title"].(string)
				return c.method == "notification.show" && title == "should-not-run"
			}) {
				t.Fatal("recovery title should-not-run was sent")
			}
			notify := notifyShowCalls(h.calls)
			if len(notify) != 0 {
				t.Fatalf("notification.show calls = %d, want 0; calls = %#v", len(notify), notify)
			}
		})
	}
}

func TestRunWorkflowInternalHerdrErrorRunsOnFailure(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
on_failure:
  herdr: notification.show
  params: { title: recovered }
steps:
  - herdr: notification.show
    params: { title: go }
`)
	h := newRunnerHarness()
	base := h.herdrCall
	attempts := 0
	deps := runnerDeps(h)
	deps.HerdrCall = func(method string, params map[string]any) (map[string]any, error) {
		if method == "notification.show" && attempts == 0 {
			attempts++
			return nil, &host.HerdrError{Code: "internal", Msg: "simulated plain Error from port"}
		}
		return base(method, params)
	}
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Deps:     deps,
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if result.OK {
		t.Fatal("result.OK = true, want false")
	}
	if result.CoordinationLost {
		t.Fatal("CoordinationLost = true, want false")
	}
	notify := notifyShowCalls(h.calls)
	if len(notify) != 1 {
		t.Fatalf("notification.show calls = %d, want 1; calls = %#v", len(notify), notify)
	}
	if title := stringParam(t, notify[0].params, "title"); title != "recovered" {
		t.Fatalf("title = %q, want %q", title, "recovered")
	}
}

func TestRunWorkflowChildFailureBubblesToEntryRecoveryWithChildAttribution(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflows(t, root, map[string]string{
		"child": `version: v1alpha1
on_failure:
  herdr: notification.show
  params: { title: child-recovery }
steps:
  - id: boom
    run: [sh, -c, "exit 1"]
`,
		"parent": `version: v1alpha1
on_failure:
  herdr: notification.show
  params:
    title: "{{context.error.workflow}}"
    body: "{{context.error.step_id}}"
steps:
  - workflow: child
`,
	})
	h := newRunnerHarness()
	result, err := RunWorkflow(RunOptions{
		Name:     "parent",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Deps:     runnerDeps(h),
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if result.OK {
		t.Fatal("result.OK = true, want false")
	}
	notify := notifyShowCalls(h.calls)
	if len(notify) != 1 {
		t.Fatalf("notification.show calls = %d, want 1; calls = %#v", len(notify), notify)
	}
	if title := stringParam(t, notify[0].params, "title"); title != "child" {
		t.Fatalf("title = %q, want %q", title, "child")
	}
	if body := stringParam(t, notify[0].params, "body"); body != "boom" {
		t.Fatalf("body = %q, want %q", body, "boom")
	}
	if slices.ContainsFunc(notify, func(c herdrCallRecord) bool {
		title, _ := c.params["title"].(string)
		return title == "child-recovery"
	}) {
		t.Fatal("child-recovery notification ran; child on_failure must not run")
	}
}

func TestRunWorkflowRepeatedChildCallsKeepEntryLoadDefinitionAfterMidRunEdit(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflows(t, root, map[string]string{
		"child": `version: v1alpha1
returns: "{{steps.mark.stdout}}"
steps:
  - id: mark
    run: [printf, original]
`,
		"parent": `version: v1alpha1
steps:
  - id: first
    workflow: child
  - id: rewrite
    run:
      - sh
      - -c
      - |
        printf '%s\n' 'version: v1alpha1' 'steps:' '  - run: "false"' > .hwf/workflows/child.yaml
  - id: second
    workflow: child
  - id: check
    run: [sh, -c, 'test "{{steps.first}}" = original -a "{{steps.second}}" = original']
`,
	})
	h := newRunnerHarness()
	result, err := RunWorkflow(RunOptions{
		Name:     "parent",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Deps:     runnerDeps(h),
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if !result.OK {
		t.Fatalf("result.OK = false, want true; Error = %q", result.Error)
	}
}

func TestRunWorkflowRecursiveChildGraphStaysFrozenForNestedMidRunEdits(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflows(t, root, map[string]string{
		"leaf": `version: v1alpha1
returns: "{{steps.mark.stdout}}"
steps:
  - id: mark
    run: [printf, leaf-v1]
`,
		"mid": `version: v1alpha1
returns: "{{steps.call}}"
steps:
  - id: call
    workflow: leaf
`,
		"parent": `version: v1alpha1
steps:
  - id: first
    workflow: mid
  - id: rewrite
    run:
      - sh
      - -c
      - |
        printf '%s\n' 'version: v1alpha1' 'steps:' '  - run: "false"' > .hwf/workflows/leaf.yaml
  - id: second
    workflow: mid
  - id: check
    run: [sh, -c, 'test "{{steps.first}}" = leaf-v1 -a "{{steps.second}}" = leaf-v1']
`,
	})
	h := newRunnerHarness()
	result, err := RunWorkflow(RunOptions{
		Name:     "parent",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Deps:     runnerDeps(h),
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if !result.OK {
		t.Fatalf("result.OK = false, want true; Error = %q", result.Error)
	}
}

func TestRunWorkflowChildHwfEnvironmentCapFailsBeforeChildStep1(t *testing.T) {
	t.Parallel()
	half := strings.Repeat("x", caps.HwfEnvByteLimit/2)
	root := t.TempDir()
	writeRunnerWorkflows(t, root, map[string]string{
		"child": `version: v1alpha1
inputs:
  a: text
  b: text
steps:
  - run: [echo, "{{inputs.a}}", "{{inputs.b}}"]
`,
		"parent": `version: v1alpha1
inputs:
  a: text
steps:
  - workflow: child
    inputs:
      a: "{{inputs.a}}"
      b: "{{inputs.a}}"
`,
	})
	h := newRunnerHarness()
	result, err := RunWorkflow(RunOptions{
		Name:     "parent",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Inputs:   map[string]string{"a": half},
		Deps:     runnerDeps(h),
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if result.OK {
		t.Fatal("result.OK = true, want false")
	}
	if !strings.Contains(result.Error, "HWF environment") {
		t.Fatalf("Error = %q, want to contain %q", result.Error, "HWF environment")
	}
}

func agentHarnessDeps(ah *agentHarness) RunnerDeps {
	return RunnerDeps{
		HerdrCall:        ah.call,
		NotificationShow: ah.notificationShow,
		AgentStatus:      ah.status,
		AgentInfo:        ah.info,
		PaneClose:        ah.paneClose,
		Sleep:            ah.clock.Sleep,
		Now:              ah.clock.Now,
		ResponseDir:      &ah.responseDir,
	}
}

func transcriptTextStub(_paneID string, _transcripts map[string]config.TranscriptExtractor, _opts TranscriptTextOpts) (string, error) {
	return "TRANSCRIPT", nil
}

func scratchGlob(t *testing.T, scratch, pattern string) []string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(scratch, pattern))
	if err != nil {
		t.Fatalf("glob %s: %v", pattern, err)
	}
	return matches
}

func TestRunWorkflowContextAgentUsesPaneIDWhenNameNull(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
steps:
  - agent: continue
    target: "{{context.agent}}"
`)
	ah := newAgentHarness(t, root)
	ah.agents["w2T:p1"] = mockAgent{
		status:           "idle",
		paneID:           "w2T:p1",
		name:             "",
		interactiveReady: true,
		launchPending:    false,
	}
	deps := agentHarnessDeps(ah)
	deps.AgentInfo = func(string) (map[string]any, error) {
		return map[string]any{
			"name":         nil,
			"pane_id":      "w2T:p1",
			"agent_status": ah.agents["w2T:p1"].status,
			"agent":        "claude",
		}, nil
	}
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root, PaneID: "w2T:p1"},
		Deps:     deps,
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if !result.OK {
		t.Fatalf("result.OK = false, want true; Error = %q", result.Error)
	}
	prompt := findCall(ah.calls, "agent.prompt")
	if prompt == nil {
		t.Fatal("agent.prompt was not called")
	}
	if target := stringParam(t, prompt.params, "target"); target != "w2T:p1" {
		t.Fatalf("agent.prompt target = %q, want %q", target, "w2T:p1")
	}
}

func TestRunWorkflowContextAgentPrefersLiveName(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
steps:
  - agent: continue
    target: "{{context.agent}}"
`)
	ah := newAgentHarness(t, root)
	ah.put(mockAgent{
		status:           "idle",
		paneID:           "w2T:p1",
		name:             "reviewer",
		interactiveReady: true,
		launchPending:    false,
	})
	deps := agentHarnessDeps(ah)
	deps.AgentInfo = func(string) (map[string]any, error) {
		return map[string]any{
			"name":         "reviewer",
			"pane_id":      "w2T:p1",
			"agent_status": ah.lookup("reviewer").status,
			"agent":        "claude",
		}, nil
	}
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root, PaneID: "w2T:p1"},
		Deps:     deps,
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if !result.OK {
		t.Fatalf("result.OK = false, want true; Error = %q", result.Error)
	}
	prompt := findCall(ah.calls, "agent.prompt")
	if prompt == nil {
		t.Fatal("agent.prompt was not called")
	}
	if target := stringParam(t, prompt.params, "target"); target != "reviewer" {
		t.Fatalf("agent.prompt target = %q, want %q", target, "reviewer")
	}
}

func TestRunWorkflowContextAgentPreflightFailsWithoutRecognizedAgent(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
steps:
  - agent: hi
    target: "{{context.agent}}"
`)
	ah := newAgentHarness(t, root)
	deps := agentHarnessDeps(ah)
	deps.AgentInfo = func(string) (map[string]any, error) {
		return map[string]any{
			"name":         nil,
			"pane_id":      "w1:p1",
			"agent_status": nil,
			"agent":        nil,
		}, nil
	}
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root, PaneID: "w1:p1"},
		Deps:     deps,
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if result.OK {
		t.Fatal("result.OK = true, want false")
	}
	if !strings.Contains(result.Error, "no recognized agent in this pane") {
		t.Fatalf("Error = %q, want to contain %q", result.Error, "no recognized agent in this pane")
	}
	if !strings.Contains(result.Error, "run this from a pane running a recognized agent") {
		t.Fatalf("Error = %q, want to contain %q", result.Error, "run this from a pane running a recognized agent")
	}
	if n := countMethod(ah.calls, "agent.prompt"); n != 0 {
		t.Fatalf("agent.prompt calls = %d, want 0", n)
	}
	if n := countMethod(ah.calls, "agent.start"); n != 0 {
		t.Fatalf("agent.start calls = %d, want 0", n)
	}
}

func TestRunWorkflowChildOnlyTranscriptFailsEntryPreflight(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflows(t, root, map[string]string{
		"child": `version: v1alpha1
steps:
  - agent: "see {{context.transcript}}"
    using: claude
`,
		"parent": `version: v1alpha1
steps:
  - workflow: child
`,
	})
	h := newRunnerHarness()
	result, err := RunWorkflow(RunOptions{
		Name:     "parent",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Deps:     runnerDeps(h),
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if result.OK {
		t.Fatal("result.OK = true, want false")
	}
	if !strings.Contains(result.Error, "context.transcript needs an invoking herdr pane") {
		t.Fatalf("Error = %q, want to contain %q", result.Error, "context.transcript needs an invoking herdr pane")
	}
	if len(h.calls) != 0 {
		t.Fatalf("HerdrCalls = %#v, want empty", h.calls)
	}
}

func TestRunWorkflowChildOnlyUnavailableIdentityFailsEntryPreflight(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflows(t, root, map[string]string{
		"child": `version: v1alpha1
steps:
  - herdr: tab.create
    params: { workspace_id: "{{context.workspace}}" }
`,
		"parent": `version: v1alpha1
steps:
  - workflow: child
`,
	})
	h := newRunnerHarness()
	result, err := RunWorkflow(RunOptions{
		Name:     "parent",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Deps:     runnerDeps(h),
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if result.OK {
		t.Fatal("result.OK = true, want false")
	}
	if !strings.Contains(result.Error, "context.workspace is not available in this invocation") {
		t.Fatalf("Error = %q, want to contain %q", result.Error, "context.workspace is not available in this invocation")
	}
	if len(h.calls) != 0 {
		t.Fatalf("HerdrCalls = %#v, want empty", h.calls)
	}
}

func TestRunWorkflowEntryReturnsRecordedOnInjectedRecorder(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
returns:
  note: "{{steps.echo.stdout}}"
  platform: "{{context.platform}}"
  cwd: "{{context.cwd}}"
steps:
  - id: echo
    run: [printf, hello]
`)
	h := newRunnerHarness()
	recorder := newFakeRecorder()
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Deps:     runnerDeps(h),
		Recorder: recorder,
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if !result.OK {
		t.Fatalf("result.OK = false, want true; Error = %q", result.Error)
	}
	if len(recorder.finishedExtras) != 1 {
		t.Fatalf("finishedExtras length = %d, want 1", len(recorder.finishedExtras))
	}
	extras := recorder.finishedExtras[0]
	if extras == nil || extras.Returns == nil {
		t.Fatalf("Finished extras Returns = %#v, want non-nil map", extras)
	}
	returns, ok := extras.Returns.(map[string]any)
	if !ok {
		t.Fatalf("Returns type %T, want map[string]any; value = %#v", extras.Returns, extras.Returns)
	}
	if note, _ := returns["note"].(string); note != "hello" {
		t.Fatalf("returns.note = %#v, want %q", returns["note"], "hello")
	}
	if cwd, _ := returns["cwd"].(string); cwd != root {
		t.Fatalf("returns.cwd = %#v, want %q", returns["cwd"], root)
	}
	platform, _ := returns["platform"].(string)
	if platform == "" {
		t.Fatalf("returns.platform = %#v, want non-empty string", returns["platform"])
	}
	if platform != string(config.Platform()) {
		t.Fatalf("returns.platform = %q, want %q", platform, config.Platform())
	}
}

func TestRunWorkflowTranscriptFileIsCleanedUp(t *testing.T) {
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
steps:
  - agent: "see {{context.transcript}}"
    using: claude
`)
	ah := newAgentHarness(t, root)
	deps := agentHarnessDeps(ah)
	var transcriptCalls int
	deps.TranscriptText = func(paneID string, transcripts map[string]config.TranscriptExtractor, opts TranscriptTextOpts) (string, error) {
		transcriptCalls++
		return transcriptTextStub(paneID, transcripts, opts)
	}
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root, WorkspaceID: "w1", TabID: "w1:t1", PaneID: "w1:p1"},
		Deps:     deps,
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if !result.OK {
		t.Fatalf("result.OK = false, want true; Error = %q", result.Error)
	}
	if transcriptCalls < 1 {
		t.Fatalf("TranscriptText calls = %d, want at least 1", transcriptCalls)
	}
	leftover := scratchGlob(t, filepath.Join(root, ".hwf", "tmp"), "*-transcript.txt")
	if len(leftover) != 0 {
		t.Fatalf("leftover transcript files = %#v, want empty", leftover)
	}
	if strings.Contains(result.Error, "TRANSCRIPT") {
		t.Fatalf("Error = %q, must not contain TRANSCRIPT", result.Error)
	}
}

func TestRunWorkflowFailedRunKeepsManagedResponseRemovesTranscript(t *testing.T) {
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
steps:
  - id: brief
    agent: "see {{context.transcript}}"
    using: claude
  - run: [sh, -c, "exit 3"]
`)
	ah := newAgentHarness(t, root)
	deps := agentHarnessDeps(ah)
	var transcriptCalls int
	deps.TranscriptText = func(paneID string, transcripts map[string]config.TranscriptExtractor, opts TranscriptTextOpts) (string, error) {
		transcriptCalls++
		return transcriptTextStub(paneID, transcripts, opts)
	}
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root, WorkspaceID: "w1", TabID: "w1:t1", PaneID: "w1:p1"},
		Deps:     deps,
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if result.OK {
		t.Fatal("result.OK = true, want false")
	}
	if transcriptCalls < 1 {
		t.Fatalf("TranscriptText calls = %d, want at least 1", transcriptCalls)
	}
	scratch := filepath.Join(root, ".hwf", "tmp")
	kept := scratchGlob(t, scratch, "*-step-*.txt")
	if len(kept) != 1 {
		t.Fatalf("kept step files = %#v, want exactly 1", kept)
	}
	got, readErr := os.ReadFile(kept[0])
	if readErr != nil {
		t.Fatalf("read %s: %v", kept[0], readErr)
	}
	if string(got) != "managed answer\n" {
		t.Fatalf("managed response = %q, want %q", got, "managed answer\n")
	}
	transcripts := scratchGlob(t, scratch, "*-transcript.txt")
	if len(transcripts) != 0 {
		t.Fatalf("transcript files = %#v, want empty", transcripts)
	}
}

func TestRunWorkflowSuccessfulRunRemovesManagedResponseAndTranscript(t *testing.T) {
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
steps:
  - id: brief
    agent: "see {{context.transcript}}"
    using: claude
`)
	ah := newAgentHarness(t, root)
	deps := agentHarnessDeps(ah)
	deps.TranscriptText = transcriptTextStub
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root, WorkspaceID: "w1", TabID: "w1:t1", PaneID: "w1:p1"},
		Deps:     deps,
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if !result.OK {
		t.Fatalf("result.OK = false, want true; Error = %q", result.Error)
	}
	leftover := scratchGlob(t, filepath.Join(root, ".hwf", "tmp"), "*.txt")
	if len(leftover) != 0 {
		t.Fatalf("scratch *.txt = %#v, want empty", leftover)
	}
}

func TestRunWorkflowRecoveryReadsTranscriptFileBeforeCleanup(t *testing.T) {
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
on_failure:
  run: [test, -f, "{{context.transcript_file}}"]
steps:
  - agent: "see {{context.transcript}}"
    using: claude
  - run: [sh, -c, "exit 3"]
`)
	ah := newAgentHarness(t, root)
	deps := agentHarnessDeps(ah)
	deps.TranscriptText = transcriptTextStub
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root, WorkspaceID: "w1", TabID: "w1:t1", PaneID: "w1:p1"},
		Deps:     deps,
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if strings.Contains(result.Error, "on_failure failed") {
		t.Fatalf("Error = %q, must not contain on_failure failed", result.Error)
	}
}

func TestRunWorkflowHwfEnvironmentCapFailsPreflight(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
inputs:
  blob: text
steps:
  - run: [echo, "{{inputs.blob}}"]
`)
	h := newRunnerHarness()
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root},
		Inputs:   map[string]string{"blob": strings.Repeat("x", caps.HwfEnvByteLimit)},
		Deps:     runnerDeps(h),
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if result.OK {
		t.Fatal("result.OK = true, want false")
	}
	if !strings.Contains(result.Error, "HWF environment") {
		t.Fatalf("Error = %q, want to contain %q", result.Error, "HWF environment")
	}
}

func TestRunWorkflowDetachedResolveDynamicFalseRequiresDomainSnapshots(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "dyn", `version: v1alpha1
inputs:
  branch:
    type: choice
    options:
      run: [printf, main]
steps:
  - run: [echo, "{{inputs.branch}}"]
`)
	h := newRunnerHarness()
	resolveDynamic := false
	missing, err := RunWorkflow(RunOptions{
		Name:           "dyn",
		RepoRoot:       root,
		Config:         runnerBaseConfig(),
		Ctx:            config.InvocationContext{Selection: "", Cwd: root},
		Inputs:         map[string]string{"branch": "main"},
		ResolveDynamic: &resolveDynamic,
		Deps:           runnerDeps(h),
		Recorder:       newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow (missing domains): %v", err)
	}
	if missing.OK {
		t.Fatal("missing domains: result.OK = true, want false")
	}
	if !strings.Contains(missing.Error, "missing launch payload domain snapshot") {
		t.Fatalf("missing domains Error = %q, want to contain %q", missing.Error, "missing launch payload domain snapshot")
	}

	ok, err := RunWorkflow(RunOptions{
		Name:           "dyn",
		RepoRoot:       root,
		Config:         runnerBaseConfig(),
		Ctx:            config.InvocationContext{Selection: "", Cwd: root},
		Inputs:         map[string]string{"branch": "main"},
		Domains:        map[string][]string{"branch": {"main"}},
		ResolveDynamic: &resolveDynamic,
		Deps:           runnerDeps(h),
		Recorder:       newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow (with domains): %v", err)
	}
	if !ok.OK {
		t.Fatalf("with domains: result.OK = false, want true; Error = %q", ok.Error)
	}
}

func TestRunWorkflowReadinessBindsNativeWaitFields(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
steps:
  - id: boot
    run: [echo, ready]
    pane: { open: tab }
    ready_when: "/ready/"
    timeout: 5s
  - id: echo
    run:
      - sh
      - -c
      - printf '%s|%s|%s|%s' "{{steps.boot.matched_line}}" "{{steps.boot.read.text}}" "{{steps.boot.read.truncated}}" "{{steps.boot.pane_id}}" > bound.txt
`)
	h := newRunnerHarness()
	deps := runnerDeps(h)
	deps.HerdrCall = func(method string, params map[string]any) (map[string]any, error) {
		if method == "pane.wait_for_output" {
			h.calls = append(h.calls, herdrCallRecord{method: method, params: params})
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
		return h.herdrCall(method, params)
	}
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root, WorkspaceID: "w1", TabID: "w1:t1", PaneID: "w1:p1"},
		Deps:     deps,
		Recorder: newFakeRecorder(),
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if !result.OK {
		t.Fatalf("result.OK = false, want true; Error = %q", result.Error)
	}
	got, readErr := os.ReadFile(filepath.Join(root, "bound.txt"))
	if readErr != nil {
		t.Fatalf("read bound.txt: %v", readErr)
	}
	if string(got) != "ready|ready output|true|w1:p3" {
		t.Fatalf("bound.txt = %q, want %q", got, "ready|ready output|true|w1:p3")
	}
}

func TestRunWorkflowVerdictBindsAsScalarAndDrivesLaterCondition(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
steps:
  - id: review
    agent: review this
    using: claude
    expect: { one_of: [APPROVE, REJECT] }
  - id: rejected
    run: [echo, rejected]
    when: '{{steps.review.verdict}} == "REJECT"'
  - id: approved
    run: [echo, approved]
    when: '{{steps.review.verdict}} == "APPROVE"'
`)
	ah := newAgentHarness(t, root)
	ah.managedResponse = "Long reasoning about the diff.\n\nREJECT\n"
	deps := RunnerDeps{
		HerdrCall:        ah.call,
		NotificationShow: ah.notificationShow,
		AgentStatus:      ah.status,
		AgentInfo:        ah.info,
		PaneClose:        ah.paneClose,
		Sleep:            ah.clock.Sleep,
		Now:              ah.clock.Now,
		ResponseDir:      &ah.responseDir,
	}
	recorder := newFakeRecorder()
	var lines []string
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Selection: "", Cwd: root, WorkspaceID: "w1", TabID: "w1:t1", PaneID: "w1:p1"},
		Deps:     deps,
		Recorder: recorder,
		OnProgress: func(i, n int, label string, outcome *ProgressOutcome) {
			lines = append(lines, formatProgressLine(i, n, label, outcome))
		},
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if !result.OK {
		t.Fatalf("result.OK = false, want true; Error = %q", result.Error)
	}
	want := []string{"[1/3] review start", "[1/3] review", "[2/3] rejected start", "[2/3] rejected", "[3/3] approved skip"}
	if !slices.Equal(lines, want) {
		t.Fatalf("lines = %#v, want %#v", lines, want)
	}
	if !slices.ContainsFunc(recorder.stepFinishedCalls, func(c fakeRecorderCall) bool {
		return c.label == "rejected" && c.outcomeKind == OutcomeSucceeded
	}) {
		t.Fatalf("stepFinishedCalls = %#v, want rejected:succeeded", recorder.stepFinishedCalls)
	}
	if !slices.ContainsFunc(recorder.stepFinishedCalls, func(c fakeRecorderCall) bool {
		return c.label == "approved" && c.outcomeKind == OutcomeSkipped
	}) {
		t.Fatalf("stepFinishedCalls = %#v, want approved:skipped", recorder.stepFinishedCalls)
	}
}
