package engine

import (
	"context"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

// RunOptions configures one top-level workflow invocation.
type RunOptions struct {
	Name           string
	RepoRoot       string
	Config         config.Config
	Ctx            config.InvocationContext
	Deps           RunnerDeps
	Inputs         map[string]string
	Domains        map[string][]string
	ResolveDynamic *bool
	Recorder       Recorder
	Workflow       *workflow.Definition
	OnProgress     func(step, total int, label string, outcome *ProgressOutcome)
	OnStderr       func(text string)
}

var identityKeys = []string{"workspace", "tab", "pane", "worktree"}

func referencedContextKeys(wf *workflow.Definition, stack []string) map[string]struct{} {
	keys := map[string]struct{}{}
	if wf == nil {
		return keys
	}
	if slices.Contains(stack, wf.Name) {
		return keys
	}
	next := append(append([]string(nil), stack...), wf.Name)
	for _, ref := range workflow.WorkflowTemplateRefs(wf.Steps, wf.Returns, wf.OnFailure) {
		if ref.Root == "context" && len(ref.Segments) > 0 {
			keys[ref.Segments[0]] = struct{}{}
		}
	}
	for _, child := range wf.Children {
		for key := range referencedContextKeys(child, next) {
			keys[key] = struct{}{}
		}
	}
	return keys
}

func identityValue(ctx config.InvocationContext, key string) string {
	switch key {
	case "workspace":
		return ctx.WorkspaceID
	case "tab":
		return ctx.TabID
	case "pane":
		return ctx.PaneID
	case "worktree":
		return ctx.WorktreePath
	default:
		return ""
	}
}

func invokingAgentTarget(ctx config.InvocationContext, deps RunnerDeps) (string, error) {
	paneID := ctx.PaneID
	if paneID == "" {
		return "", fmt.Errorf("context.agent needs an invoking herdr pane")
	}
	if deps.AgentInfo == nil {
		return "", fmt.Errorf("context.agent is unavailable: no recognized agent in this pane — run this from a pane running a recognized agent")
	}
	info, err := deps.AgentInfo(paneID)
	if err != nil {
		return "", err
	}
	name := ""
	if v, ok := info["name"].(string); ok {
		name = strings.TrimSpace(v)
	}
	if name != "" {
		return name, nil
	}
	kind := ""
	if v, ok := info["agent"].(string); ok {
		kind = strings.TrimSpace(v)
	}
	if kind == "" {
		return "", fmt.Errorf("context.agent is unavailable: no recognized agent in this pane — run this from a pane running a recognized agent")
	}
	return paneID, nil
}

func writeTranscriptFile(repoRoot, runID, text string) (string, error) {
	dir, err := EnsureRunScratchDir(repoRoot, "")
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, runID+"-transcript.txt")
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		return "", err
	}
	return path, nil
}

type preflightResult struct {
	ok             bool
	values         workflow.TemplateNamespace
	transcriptFile string
	err            string
}

func loadTranscriptContext(
	ctx config.InvocationContext,
	cfg config.Config,
	deps RunnerDeps,
	runID, repoRoot string,
	needTranscriptFile bool,
) (text string, transcriptFile string, errMsg string) {
	if ctx.PaneID == "" {
		return "", "", "context.transcript needs an invoking herdr pane"
	}
	if deps.TranscriptText == nil {
		return "", "", "context.transcript is unavailable"
	}
	text, err := deps.TranscriptText(ctx.PaneID, cfg.Transcripts, TranscriptTextOpts{
		InvocationCwd: ctx.Cwd,
	})
	if err != nil {
		return "", "", err.Error()
	}
	if !needTranscriptFile {
		return text, "", ""
	}
	path, err := writeTranscriptFile(repoRoot, runID, text)
	if err != nil {
		return "", "", err.Error()
	}
	return text, path, ""
}

func preflightContext(
	wf *workflow.Definition,
	ctx config.InvocationContext,
	cfg config.Config,
	deps RunnerDeps,
	runID, repoRoot string,
	inputs map[string]string,
) preflightResult {
	keys := referencedContextKeys(wf, nil)
	for _, key := range identityKeys {
		if _, need := keys[key]; need && identityValue(ctx, key) == "" {
			return preflightResult{err: fmt.Sprintf("context.%s is not available in this invocation", key)}
		}
	}

	nsOpts := workflow.NamespaceOpts{
		Ctx:    ctx,
		Inputs: stringInputsToAny(inputs),
		Steps:  map[string]any{},
	}

	if _, need := keys["agent"]; need {
		agent, err := invokingAgentTarget(ctx, deps)
		if err != nil {
			return preflightResult{err: err.Error()}
		}
		nsOpts.Agent = agent
	}

	_, needTranscript := keys["transcript"]
	_, needTranscriptFile := keys["transcript_file"]
	var transcriptFile string
	if needTranscript || needTranscriptFile {
		text, path, errMsg := loadTranscriptContext(ctx, cfg, deps, runID, repoRoot, needTranscriptFile)
		if errMsg != "" {
			return preflightResult{err: errMsg}
		}
		nsOpts.Transcript = &text
		if path != "" {
			transcriptFile = path
			nsOpts.TranscriptFile = &transcriptFile
		}
	}

	return preflightResult{
		ok:             true,
		values:         workflow.BuildTemplateNamespace(nsOpts),
		transcriptFile: transcriptFile,
	}
}

func fail(deps RunnerDeps, name string, step int, detail string) string {
	text := fmt.Sprintf("step %d: %s", step, detail)
	if deps.NotificationShow != nil {
		body := fmt.Sprintf("Step %d failed; inspect the terminal or run history for details.", step)
		title := fmt.Sprintf("herdr-workflows: %s failed", name)
		_ = deps.NotificationShow(title, &body)
	}
	return text
}

func stepLabel(step workflow.Step) string {
	if step.ID != "" {
		return step.ID
	}
	switch a := step.Action.(type) {
	case *workflow.RunAction:
		return runStepLabel(a)
	case workflow.RunAction:
		return runStepLabel(&a)
	case *workflow.AgentAction, workflow.AgentAction:
		return "agent"
	case *workflow.HerdrAction:
		return a.Method
	case workflow.HerdrAction:
		return a.Method
	case *workflow.WorkflowAction:
		return "workflow: " + a.Name
	case workflow.WorkflowAction:
		return "workflow: " + a.Name
	default:
		return "step"
	}
}

func runStepLabel(a *workflow.RunAction) string {
	if a.Payload.IsArgv() {
		return "run: " + strings.Join(a.Payload.Argv, " ")
	}
	cmd := a.Payload.Command
	if i := strings.IndexByte(cmd, '\n'); i >= 0 {
		cmd = cmd[:i]
	}
	return "run: " + cmd
}

func progressOutcomeOf(kind StepOutcomeKind) ProgressOutcome {
	switch kind {
	case OutcomeSucceeded:
		return ProgressOk
	case OutcomeSkipped:
		return ProgressSkip
	case OutcomeLaunched:
		return ProgressLaunch
	case OutcomeFailedContinued, OutcomeFailed, OutcomeInterrupted:
		return ProgressFail
	default:
		return ProgressFail
	}
}

func emitProgress(opts StepRunOpts, step, total int, label string, outcome ProgressOutcome) {
	if opts.OnProgress == nil {
		return
	}
	o := outcome
	opts.OnProgress(step, total, label, &o)
}

func bindResult(step workflow.Step, values workflow.TemplateNamespace, outcome StepOutcome) {
	if step.ID == "" || !outcome.OK || outcome.Result == nil {
		return
	}
	values.Steps[step.ID] = outcome.Result
}

func retryOf(step workflow.Step) *workflow.RetrySpec {
	switch a := step.Action.(type) {
	case *workflow.RunAction:
		return a.Retry
	case workflow.RunAction:
		return a.Retry
	case *workflow.HerdrAction:
		return a.Retry
	case workflow.HerdrAction:
		return a.Retry
	default:
		return nil
	}
}

func failureOf(opts StepRunOpts, step workflow.Step, stepIndex int, outcome StepOutcome) *StepFailure {
	if outcome.Failure != nil {
		return outcome.Failure
	}
	details := maps.Clone(outcome.Details)
	if details == nil {
		details = map[string]any{}
	}
	switch a := step.Action.(type) {
	case *workflow.HerdrAction:
		details["method"] = a.Method
		details["reason"] = outcome.Error
	case workflow.HerdrAction:
		details["method"] = a.Method
		details["reason"] = outcome.Error
	case *workflow.WorkflowAction:
		details["workflow"] = a.Name
	case workflow.WorkflowAction:
		details["workflow"] = a.Name
	}
	return &StepFailure{
		Message:      outcome.Error,
		Workflow:     opts.Name,
		Action:       StepActionKind(workflow.ActionKind(step.Action)),
		StepNumber:   stepIndex,
		WorkflowPath: append([]string(nil), opts.WorkflowPath...),
		StepID:       step.ID,
		Details:      details,
	}
}

// errorContextOf shapes StepFailure for {{context.error.*}} template walks.
func errorContextOf(failure *StepFailure) map[string]any {
	details := maps.Clone(failure.Details)
	if details == nil {
		details = map[string]any{}
	}
	out := map[string]any{
		"message":       failure.Message,
		"workflow":      failure.Workflow,
		"action":        string(failure.Action),
		"step_number":   failure.StepNumber,
		"workflow_path": append([]string(nil), failure.WorkflowPath...),
		"details":       details,
	}
	if failure.StepID != "" {
		out["step_id"] = failure.StepID
	}
	return out
}

func toRecorderOutcome(outcome StepOutcome) *RecorderOutcome {
	return &RecorderOutcome{
		OK:               outcome.OK,
		Truncated:        outcome.Truncated,
		Error:            outcome.Error,
		Details:          outcome.Details,
		CoordinationLost: outcome.CoordinationLost,
	}
}

func evaluateReturns(returns *workflow.ReturnsSpec, ns workflow.TemplateNamespace) any {
	if returns.Template != "" {
		return workflow.SubstituteValue(returns.Template, ns)
	}
	out := make(map[string]any, len(returns.Fields))
	for _, field := range returns.Fields {
		out[field.Name] = workflow.SubstituteValue(field.Template, ns)
	}
	return out
}

func workflowStep(frame StepFrame) (StepOutcome, error) {
	action, ok := asWorkflowAction(frame.Step.Action)
	if !ok {
		return StepOutcome{OK: false, Error: "internal: not a workflow step"}, nil
	}
	return runChild(frame, action)
}

func runChild(frame StepFrame, action *workflow.WorkflowAction) (StepOutcome, error) {
	child := frame.Opts.Children[action.Name]
	if child == nil {
		return StepOutcome{
			OK:      false,
			Error:   fmt.Sprintf("workflow '%s' missing from loaded child graph", action.Name),
			Details: map[string]any{"workflow": action.Name},
		}, nil
	}

	passed := make(map[string]string, len(action.Inputs))
	for name, template := range action.Inputs {
		passed[name] = workflow.SubstituteText(template, frame.Values)
	}

	resolveDynamic := true
	collected, err := workflow.CompleteWorkflowInputs(context.Background(), child, workflow.InputSessionOptions{
		Config:         frame.Opts.Config,
		RepoRoot:       frame.Opts.RepoRoot,
		ResolveDynamic: &resolveDynamic,
	}, passed)
	if err != nil {
		return StepOutcome{
			OK:      false,
			Error:   err.Error(),
			Details: map[string]any{"workflow": child.Name},
		}, nil
	}
	if err := caps.AssertHwfEnvValues("HWF environment", collected.Values); err != nil {
		return StepOutcome{
			OK:      false,
			Error:   err.Error(),
			Details: map[string]any{"workflow": child.Name},
		}, nil
	}

	childValues := workflow.TemplateNamespace{
		Inputs:  stringInputsToAny(collected.Values),
		Steps:   map[string]any{},
		Context: frame.Values.Context,
	}
	childPath := append(append([]string(nil), frame.Opts.WorkflowPath...), child.Name)
	parentOrdinal := frame.StepIndex
	childOpts := frame.Opts
	childOpts.Name = child.Name
	childOpts.WorkflowPath = childPath
	childOpts.Children = child.Children
	childOpts.Recorder = frame.Opts.Recorder.Child(RecorderScope{
		Name:          child.Name,
		WorkflowPath:  childPath,
		ParentOrdinal: &parentOrdinal,
	})

	result, err := frame.Opts.RunSteps(child.Steps, childOpts, childValues)
	if err != nil {
		return StepOutcome{}, err
	}
	if !result.OK {
		out := StepOutcome{
			OK:               false,
			Error:            result.Error,
			Details:          map[string]any{"workflow": child.Name},
			Failure:          result.Failure,
			CoordinationLost: result.CoordinationLost,
		}
		return out, nil
	}
	if child.Returns == nil {
		return StepOutcome{OK: true}, nil
	}
	return StepOutcome{OK: true, Result: evaluateReturns(child.Returns, childValues)}, nil
}

func executeOnce(step workflow.Step, stepIndex int, values workflow.TemplateNamespace, opts StepRunOpts) (StepOutcome, error) {
	frame := StepFrame{Step: step, StepIndex: stepIndex, Values: values, Opts: opts}
	switch workflow.ActionKind(step.Action) {
	case "run":
		return ShellStep(frame)
	case "herdr":
		return HerdrStep(frame)
	case "agent":
		return AgentStep(&frame)
	case "workflow":
		return workflowStep(frame)
	default:
		return StepOutcome{OK: false, Error: "internal: unknown step action"}, nil
	}
}

func executeWithRetry(step workflow.Step, stepIndex int, values workflow.TemplateNamespace, opts StepRunOpts) (StepOutcome, error) {
	retry := retryOf(step)
	attempts := 1
	var delay time.Duration
	if retry != nil {
		attempts = retry.Attempts
		delay = retry.Delay
	}
	var last StepOutcome
	for attempt := 1; attempt <= attempts; attempt++ {
		outcome, err := executeOnce(step, stepIndex, values, opts)
		if err != nil {
			return StepOutcome{}, err
		}
		last = outcome
		if last.OK || last.CoordinationLost {
			return last, nil
		}
		if attempt < attempts && delay > 0 {
			opts.Deps.Sleep(delay)
		}
	}
	return last, nil
}

func hardStepFailure(
	opts StepRunOpts,
	step workflow.Step,
	stepIndex, total int,
	label string,
	outcome StepOutcome,
	tolerated []string,
	interrupted bool,
) StepsResult {
	errText := fail(opts.Deps, opts.Name, stepIndex, outcome.Error)
	recorded := toRecorderOutcome(outcome)
	recorded.Error = errText
	kind := OutcomeFailed
	if interrupted {
		kind = OutcomeInterrupted
	}
	_ = opts.Recorder.StepFinished(step, stepIndex, total, label, kind, recorded, PhaseMain)
	result := StepsResult{
		OK:      false,
		Error:   errText,
		Aborted: true,
		Failure: failureOf(opts, step, stepIndex, outcome),
	}
	if interrupted {
		result.CoordinationLost = true
	}
	if len(tolerated) > 0 {
		result.Failures = tolerated
	}
	return result
}

func runSteps(steps []workflow.Step, opts StepRunOpts, values workflow.TemplateNamespace) (StepsResult, error) {
	total := len(steps)
	var tolerated []string
	for n, step := range steps {
		n++
		label := stepLabel(step)
		if len(step.When) > 0 && !workflow.EvaluateWhen(step.When, values) {
			emitProgress(opts, n, total, label, ProgressSkip)
			_ = opts.Recorder.StepFinished(step, n, total, label, OutcomeSkipped, nil, PhaseMain)
			continue
		}
		emitProgress(opts, n, total, label, ProgressStart)
		_ = opts.Recorder.StepStarted(step, n, total, label, PhaseMain)
		outcome, err := executeWithRetry(step, n, values, opts)
		if err != nil {
			return StepsResult{}, err
		}
		kind := RecordedOutcomeKind(outcome)
		if !outcome.OK {
			emitProgress(opts, n, total, label, progressOutcomeOf(kind))
			if outcome.CoordinationLost {
				return hardStepFailure(opts, step, n, total, label, outcome, tolerated, true), nil
			}
			if step.ContinueOnError && !outcome.HardFailure {
				tolerated = append(tolerated, outcome.Error)
				_ = opts.Recorder.StepFinished(step, n, total, label, OutcomeFailedContinued, toRecorderOutcome(outcome), PhaseMain)
				continue
			}
			return hardStepFailure(opts, step, n, total, label, outcome, tolerated, false), nil
		}
		bindResult(step, values, outcome)
		emitProgress(opts, n, total, label, progressOutcomeOf(kind))
		_ = opts.Recorder.StepFinished(step, n, total, label, kind, toRecorderOutcome(outcome), PhaseMain)
	}
	if len(tolerated) > 0 {
		return StepsResult{OK: false, Error: strings.Join(tolerated, "; "), Failures: tolerated}, nil
	}
	return StepsResult{OK: true}, nil
}

func runRecovery(
	action workflow.Action,
	opts StepRunOpts,
	values workflow.TemplateNamespace,
	failure *StepFailure,
) (StepOutcome, error) {
	ctx := maps.Clone(values.Context)
	if ctx == nil {
		ctx = map[string]any{}
	}
	ctx["error"] = errorContextOf(failure)
	recoveryValues := workflow.TemplateNamespace{
		Inputs:  values.Inputs,
		Steps:   values.Steps,
		Context: ctx,
	}
	step := workflow.Step{Action: action}
	label := stepLabel(step)
	recoveryPath := append(append([]string(nil), opts.WorkflowPath...), opts.Name+":on_failure")
	parentOrdinal := failure.StepNumber
	recoveryOpts := opts
	recoveryOpts.WorkflowPath = recoveryPath
	recoveryOpts.Recorder = opts.Recorder.Child(RecorderScope{
		Name:          opts.Name,
		WorkflowPath:  recoveryPath,
		ParentOrdinal: &parentOrdinal,
	})
	_ = recoveryOpts.Recorder.StepStarted(step, 1, 1, label, PhaseRecovery)
	outcome, err := executeOnce(step, 0, recoveryValues, recoveryOpts)
	if err != nil {
		return StepOutcome{}, err
	}
	_ = recoveryOpts.Recorder.StepFinished(
		step, 1, 1, label, RecordedOutcomeKind(outcome), toRecorderOutcome(outcome), PhaseRecovery,
	)
	return outcome, nil
}

func shouldRunRecovery(primary StepsResult, loaded *workflow.Definition) bool {
	return !primary.OK && primary.Aborted && !primary.CoordinationLost && loaded.OnFailure != nil && primary.Failure != nil
}

func finalizeFailedRecovery(primary StepsResult, recovery StepOutcome, opts StepRunOpts) (StepsResult, error) {
	errText := fmt.Sprintf("%s; on_failure failed: %s", primary.Error, recovery.Error)
	status := StatusFailed
	if recovery.CoordinationLost {
		status = StatusInterrupted
	}
	_ = opts.Recorder.Finished(status, &RecorderFinishExtras{Error: errText})
	result := StepsResult{
		OK:      false,
		Error:   errText,
		Aborted: true,
		Failure: primary.Failure,
	}
	if primary.Failures != nil {
		result.Failures = primary.Failures
	}
	if recovery.CoordinationLost {
		result.CoordinationLost = true
	}
	return result, nil
}

func finalizeEntryRun(
	primary StepsResult,
	loaded *workflow.Definition,
	opts StepRunOpts,
	values workflow.TemplateNamespace,
) (StepsResult, error) {
	if shouldRunRecovery(primary, loaded) {
		recovery, err := runRecovery(loaded.OnFailure, opts, values, primary.Failure)
		if err != nil {
			return StepsResult{}, err
		}
		if !recovery.OK {
			return finalizeFailedRecovery(primary, recovery, opts)
		}
	}
	status := StatusSucceeded
	if !primary.OK {
		if primary.CoordinationLost {
			status = StatusInterrupted
		} else {
			status = StatusFailed
		}
	}
	var extras *RecorderFinishExtras
	if primary.OK && loaded.Returns != nil {
		extras = &RecorderFinishExtras{Returns: evaluateReturns(loaded.Returns, values)}
	} else if !primary.OK {
		extras = &RecorderFinishExtras{Error: primary.Error}
	}
	_ = opts.Recorder.Finished(status, extras)
	return primary, nil
}

func stringInputsToAny(values map[string]string) map[string]any {
	out := make(map[string]any, len(values))
	for k, v := range values {
		out[k] = v
	}
	return out
}

// RunWorkflow loads (or uses) a workflow, collects inputs, runs steps, and finalizes.
func RunWorkflow(opts RunOptions) (StepsResult, error) {
	if opts.Recorder == nil {
		return StepsResult{}, fmt.Errorf("recorder is required")
	}
	recorder := opts.Recorder

	deps := opts.Deps
	if deps.Sleep == nil {
		deps.Sleep = time.Sleep
	}
	if deps.Now == nil {
		deps.Now = time.Now
	}

	loaded := opts.Workflow
	if loaded == nil {
		var err error
		loaded, err = workflow.LoadWorkflow(opts.Name, opts.RepoRoot, opts.Config)
		if err != nil {
			return StepsResult{}, err
		}
	}

	managedResponseFiles := []string{}
	stepOpts := StepRunOpts{
		Name:                 loaded.Name,
		RepoRoot:             opts.RepoRoot,
		Config:               opts.Config,
		Ctx:                  opts.Ctx,
		Deps:                 deps,
		RunID:                recorder.RunID(),
		WorkflowPath:         []string{loaded.Name},
		Children:             loaded.Children,
		ManagedResponseFiles: &managedResponseFiles,
		Recorder:             recorder,
		OnProgress:           opts.OnProgress,
		OnStderr:             opts.OnStderr,
	}
	stepOpts.RunSteps = runSteps

	var transcriptFile string
	succeeded := false
	defer func() {
		recorder.Dispose()
		if transcriptFile != "" {
			_ = os.Remove(transcriptFile)
		}
		if succeeded {
			for _, path := range managedResponseFiles {
				_ = os.Remove(path)
			}
		}
		if opts.Ctx.PaneID != "" && deps.ReportToken != nil {
			_ = deps.ReportToken(opts.Ctx.PaneID, nil)
		}
	}()

	failPrecondition := func(detail string) StepsResult {
		errText := fail(deps, loaded.Name, 0, detail)
		_ = recorder.Finished(StatusFailed, &RecorderFinishExtras{Error: errText})
		return StepsResult{OK: false, Error: errText}
	}

	collected, err := workflow.CompleteWorkflowInputs(context.Background(), loaded, workflow.InputSessionOptions{
		Config:         opts.Config,
		RepoRoot:       opts.RepoRoot,
		Domains:        opts.Domains,
		ResolveDynamic: opts.ResolveDynamic,
	}, opts.Inputs)
	if err != nil {
		return failPrecondition(err.Error()), nil
	}

	if err := caps.AssertHwfEnvValues("HWF environment", collected.Values); err != nil {
		return failPrecondition(err.Error()), nil
	}

	preflight := preflightContext(loaded, opts.Ctx, opts.Config, deps, recorder.RunID(), opts.RepoRoot, collected.Values)
	if !preflight.ok {
		return failPrecondition(preflight.err), nil
	}
	transcriptFile = preflight.transcriptFile

	primary, err := runSteps(loaded.Steps, stepOpts, preflight.values)
	if err != nil {
		return StepsResult{}, err
	}
	final, err := finalizeEntryRun(primary, loaded, stepOpts, preflight.values)
	if err != nil {
		return StepsResult{}, err
	}
	succeeded = final.OK
	return final, nil
}
