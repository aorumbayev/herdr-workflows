package engine

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func loadResumeWorkflow(t *testing.T, bodies map[string]string) *workflow.Definition {
	t.Helper()
	root := t.TempDir()
	writeRunnerWorkflows(t, root, bodies)
	def, err := workflow.LoadWorkflow("m", root, runnerBaseConfig())
	if err != nil {
		t.Fatalf("LoadWorkflow: %v", err)
	}
	return def
}

func TestStepFingerprintsTrackEachStepAndItsChildGraph(t *testing.T) {
	t.Parallel()
	base := map[string]string{
		"m": "version: v1alpha1\nsteps:\n  - run: [echo, a]\n  - workflow: c\n  - run: [echo, b]\n",
		"c": "version: v1alpha1\nsteps:\n  - run: [echo, child]\n",
	}
	first := StepFingerprints(loadResumeWorkflow(t, base))
	if len(first) != 3 {
		t.Fatalf("fingerprints = %d, want 3", len(first))
	}
	editedLast := map[string]string{
		"m": "version: v1alpha1\nsteps:\n  - run: [echo, a]\n  - workflow: c\n  - run: [echo, changed]\n",
		"c": base["c"],
	}
	second := StepFingerprints(loadResumeWorkflow(t, editedLast))
	if first[0] != second[0] || first[1] != second[1] || first[2] == second[2] {
		t.Fatalf("only step 3 must change: %v vs %v", first, second)
	}
	editedChild := map[string]string{
		"m": base["m"],
		"c": "version: v1alpha1\nsteps:\n  - run: [echo, other]\n",
	}
	third := StepFingerprints(loadResumeWorkflow(t, editedChild))
	if first[1] == third[1] || first[0] != third[0] {
		t.Fatalf("child edit must change only the workflow step: %v vs %v", first, third)
	}
}

func resumeSource(def *workflow.Definition, steps ...RetrySourceStep) RetrySource {
	return RetrySource{Fingerprints: StepFingerprints(def), Steps: steps}
}

func TestPlanResumeStartsAtFirstStepThatDidNotFinishWell(t *testing.T) {
	t.Parallel()
	def := loadResumeWorkflow(t, map[string]string{"m": `version: v1alpha1
steps:
  - id: a
    run: [echo, a]
  - run: [echo, b]
    when: "{{steps.a.stdout}}"
  - run: [echo, c]
  - run: [echo, d]
    continue_on_error: true
  - run: [echo, e]
`})
	src := resumeSource(def,
		RetrySourceStep{Ordinal: 1, StepID: "a", Outcome: OutcomeSucceeded, HasResult: true, Result: map[string]any{"stdout": "a"}},
		RetrySourceStep{Ordinal: 2, Outcome: OutcomeSkipped},
		RetrySourceStep{Ordinal: 3, Outcome: OutcomeSucceeded},
		RetrySourceStep{Ordinal: 4, Outcome: OutcomeFailedContinued},
		RetrySourceStep{Ordinal: 5, Outcome: OutcomeFailed},
	)
	plan, err := PlanResume(def, src)
	if err != nil {
		t.Fatalf("PlanResume: %v", err)
	}
	if plan.From != 4 || len(plan.Reused) != 3 {
		t.Fatalf("plan = %+v, want From 4 with 3 reused", plan)
	}
	if plan.Reused[1].Outcome != OutcomeSkipped || plan.Reused[2].Outcome != OutcomeSucceeded {
		t.Fatalf("reused outcomes = %+v", plan.Reused)
	}
}

func TestPlanResumeRefusesLaunchedBackgroundStep(t *testing.T) {
	t.Parallel()
	def := loadResumeWorkflow(t, map[string]string{"m": "version: v1alpha1\nsteps:\n  - run: [echo, a]\n  - run: [echo, b]\n"})
	_, err := PlanResume(def, resumeSource(def,
		RetrySourceStep{Ordinal: 1, Outcome: OutcomeLaunched},
		RetrySourceStep{Ordinal: 2, Outcome: OutcomeFailed},
	))
	if err == nil || !strings.Contains(err.Error(), "launched background work") {
		t.Fatalf("err = %v", err)
	}
}

func TestPlanResumeStaleRunStartsAfterLastRecordedStep(t *testing.T) {
	t.Parallel()
	def := loadResumeWorkflow(t, map[string]string{"m": "version: v1alpha1\nsteps:\n  - run: [echo, a]\n  - run: [echo, b]\n  - run: [echo, c]\n"})
	plan, err := PlanResume(def, resumeSource(def, RetrySourceStep{Ordinal: 1, Outcome: OutcomeSucceeded}))
	if err != nil {
		t.Fatalf("PlanResume: %v", err)
	}
	if plan.From != 2 {
		t.Fatalf("From = %d, want 2", plan.From)
	}
}

func TestPlanResumeRefusesWhenNothingFailed(t *testing.T) {
	t.Parallel()
	def := loadResumeWorkflow(t, map[string]string{"m": "version: v1alpha1\nsteps:\n  - run: [echo, a]\n"})
	_, err := PlanResume(def, resumeSource(def, RetrySourceStep{Ordinal: 1, Outcome: OutcomeSucceeded}))
	if err == nil || !strings.Contains(err.Error(), "nothing to resume") {
		t.Fatalf("err = %v, want nothing to resume", err)
	}
}

func TestPlanResumeAllowsEditsFromTheResumePointOnly(t *testing.T) {
	t.Parallel()
	before := loadResumeWorkflow(t, map[string]string{"m": "version: v1alpha1\nsteps:\n  - run: [echo, a]\n  - id: b\n    run: [echo, b]\n"})
	src := resumeSource(before,
		RetrySourceStep{Ordinal: 1, Outcome: OutcomeSucceeded},
		RetrySourceStep{Ordinal: 2, StepID: "b", Outcome: OutcomeFailed},
	)
	fixedFailed := loadResumeWorkflow(t, map[string]string{"m": "version: v1alpha1\nsteps:\n  - run: [echo, a]\n  - id: b\n    run: [echo, fixed]\n"})
	if _, err := PlanResume(fixedFailed, src); err != nil {
		t.Fatalf("editing the failed step must be allowed: %v", err)
	}
	editedEarlier := loadResumeWorkflow(t, map[string]string{"m": "version: v1alpha1\nsteps:\n  - run: [echo, changed]\n  - id: b\n    run: [echo, b]\n"})
	_, err := PlanResume(editedEarlier, src)
	if err == nil || !strings.Contains(err.Error(), "step 1 (run: echo changed) changed") {
		t.Fatalf("err = %v, want step 1 changed", err)
	}
}

func TestPlanResumeRefusesMissingRecordedResult(t *testing.T) {
	t.Parallel()
	def := loadResumeWorkflow(t, map[string]string{"m": "version: v1alpha1\nsteps:\n  - id: a\n    run: [echo, a]\n  - run: [echo, b]\n"})
	_, err := PlanResume(def, resumeSource(def,
		RetrySourceStep{Ordinal: 1, StepID: "a", Outcome: OutcomeSucceeded},
		RetrySourceStep{Ordinal: 2, Outcome: OutcomeFailed},
	))
	if err == nil || !strings.Contains(err.Error(), "result of step 1 (a) was not recorded") {
		t.Fatalf("err = %v, want missing result", err)
	}
}

type retryPlanRecorder struct {
	*fakeRecorder
	inputs       map[string]string
	fingerprints []string
	reused       []int
	results      map[int]any
}

func (r *retryPlanRecorder) RecordRetryPlan(collected workflow.CollectedInputs, fingerprints []string, _ map[string]any) {
	r.inputs = collected.Values
	r.fingerprints = fingerprints
}

func (r *retryPlanRecorder) StepFinished(step workflow.Step, ordinal, total int, label string, kind StepOutcomeKind, outcome *RecorderOutcome, phase StepPhase) error {
	if outcome != nil && outcome.Reused {
		r.reused = append(r.reused, ordinal)
	}
	if outcome != nil && outcome.Result != nil {
		if r.results == nil {
			r.results = map[int]any{}
		}
		r.results[ordinal] = outcome.Result
	}
	return r.fakeRecorder.StepFinished(step, ordinal, total, label, kind, outcome, phase)
}

func TestRunWorkflowRecordsRetryPlanAndStepResults(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
inputs:
  who: text
steps:
  - id: probe
    run: [sh, -c, "printf hi"]
  - run: [echo, "{{inputs.who}}"]
`)
	rec := &retryPlanRecorder{fakeRecorder: newFakeRecorder()}
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Cwd: root},
		Deps:     runnerDeps(newRunnerHarness()),
		Inputs:   map[string]string{"who": "ada"},
		Recorder: rec,
	})
	if err != nil || !result.OK {
		t.Fatalf("RunWorkflow: %v %+v", err, result)
	}
	if rec.inputs["who"] != "ada" || len(rec.fingerprints) != 2 {
		t.Fatalf("plan = %v %v", rec.inputs, rec.fingerprints)
	}
	got, ok := rec.results[1].(map[string]any)
	if !ok || got["stdout"] != "hi" {
		t.Fatalf("results = %#v", rec.results)
	}
}

func TestRunWorkflowResumeReusesEarlierStepsAndRunsTheRest(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
steps:
  - id: probe
    run: [sh, -c, "touch probe-ran; printf fresh"]
  - run: [sh, -c, "touch skipped-ran"]
    when: "{{steps.probe.stdout}}"
  - run: [sh, -c, 'printf "%s" "$MSG" > out.txt']
    env: { MSG: "{{steps.probe.stdout}}" }
`)
	rec := &retryPlanRecorder{fakeRecorder: newFakeRecorder()}
	var progress []string
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Cwd: root},
		Deps:     runnerDeps(newRunnerHarness()),
		Recorder: rec,
		Resume: &Resume{From: 3, Reused: []ReusedStep{
			{Outcome: OutcomeSucceeded, Result: map[string]any{"stdout": "saved"}},
			{Outcome: OutcomeSkipped},
		}},
		OnProgress: func(step, total int, label string, outcome *ProgressOutcome) {
			if outcome != nil {
				progress = append(progress, formatProgressEvent(step, total, label, outcome))
			}
		},
	})
	if err != nil || !result.OK {
		t.Fatalf("RunWorkflow: %v %+v", err, result)
	}
	for _, marker := range []string{"probe-ran", "skipped-ran"} {
		if _, err := os.Stat(filepath.Join(root, marker)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s exists; reused steps must not run", marker)
		}
	}
	out, err := os.ReadFile(filepath.Join(root, "out.txt"))
	if err != nil || string(out) != "saved" {
		t.Fatalf("out.txt = %q %v, want saved", out, err)
	}
	if len(rec.reused) != 2 || rec.reused[0] != 1 || rec.reused[1] != 2 {
		t.Fatalf("reused = %v, want [1 2]", rec.reused)
	}
	if len(rec.stepFinishedCalls) != 3 || rec.stepFinishedCalls[1].outcomeKind != OutcomeSkipped {
		t.Fatalf("stepFinished = %+v", rec.stepFinishedCalls)
	}
	if progress[0] != "1/3:probe:reused" {
		t.Fatalf("progress = %v", progress)
	}
}

func TestRunWorkflowResumeRerunsAFailedChildInFull(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflows(t, root, map[string]string{
		"m": "version: v1alpha1\nsteps:\n  - run: [sh, -c, \"touch first-ran\"]\n  - workflow: c\n",
		"c": "version: v1alpha1\nsteps:\n  - run: [sh, -c, \"touch c1\"]\n  - run: [sh, -c, \"touch c2\"]\n",
	})
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Cwd: root},
		Deps:     runnerDeps(newRunnerHarness()),
		Recorder: newFakeRecorder(),
		Resume:   &Resume{From: 2, Reused: []ReusedStep{{Outcome: OutcomeSucceeded}}},
	})
	if err != nil || !result.OK {
		t.Fatalf("RunWorkflow: %v %+v", err, result)
	}
	for _, marker := range []string{"c1", "c2"} {
		if _, err := os.Stat(filepath.Join(root, marker)); err != nil {
			t.Fatalf("child step %s must run: %v", marker, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "first-ran")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("reused entry step ran")
	}
}

func TestRunWorkflowResumeRefusesAGonePaneThatALaterStepNeeds(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeRunnerWorkflow(t, root, "m", `version: v1alpha1
steps:
  - id: srv
    run: [sh, -c, "echo ready"]
    pane: { open: tab }
    ready_when: /ready/
    timeout: 5s
  - herdr: pane.send_text
    params: { pane_id: "{{steps.srv.pane_id}}", text: hi }
`)
	h := newRunnerHarness()
	deps := runnerDeps(h)
	deps.HerdrCall = func(method string, params map[string]any) (map[string]any, error) {
		h.calls = append(h.calls, herdrCallRecord{method: method, params: params})
		if method == "pane.get" {
			return nil, errors.New("pane not found")
		}
		return map[string]any{}, nil
	}
	result, err := RunWorkflow(RunOptions{
		Name:     "m",
		RepoRoot: root,
		Config:   runnerBaseConfig(),
		Ctx:      config.InvocationContext{Cwd: root},
		Deps:     deps,
		Recorder: newFakeRecorder(),
		Resume: &Resume{From: 2, Reused: []ReusedStep{
			{Outcome: OutcomeSucceeded, Result: map[string]any{"pane_id": "w1:p9"}},
		}},
	})
	if err != nil {
		t.Fatalf("RunWorkflow: %v", err)
	}
	if result.OK || !strings.Contains(result.Error, "pane w1:p9 from step 1 (srv) is gone") {
		t.Fatalf("result = %+v, want gone pane refusal", result)
	}
	if h.hasMethod("pane.send_text") {
		t.Fatal("step 2 ran after the pane check failed")
	}
}
