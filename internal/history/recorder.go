package history

import (
	"os"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/engine"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

type CreateRecorderOpts struct {
	Workflow     workflow.Definition
	RunID        string
	CheckoutRoot string
	OnAck        func(string)
	Getenv       func(string) string
}

type recorder struct {
	writer *Writer
	runID  string
	scope  engine.RecorderScope
	state  *recorderState
	getenv func(string) string
}

type recorderState struct {
	finalized bool
}

func CreateRunRecorder(opts CreateRecorderOpts) (engine.Recorder, error) {
	w := NewWriter(opts.Getenv)
	claim := w.Claim(ClaimMeta{
		ID:           opts.RunID,
		Workflow:     opts.Workflow.Name,
		Title:        opts.Workflow.Title,
		Source:       sourceOf(opts.Workflow),
		CheckoutRoot: opts.CheckoutRoot,
	})
	scope := engine.RecorderScope{Name: opts.Workflow.Name, WorkflowPath: []string{opts.Workflow.Name}}
	if !claim.OK {
		emitAck(opts.OnAck, FormatHistoryAck(Ack{State: "rejected", ID: claim.ID, Error: claim.Error}))
		w.Dispose()
		return nil, errClaim(claim.Error)
	}
	if claim.State == "unavailable" {
		emitAck(opts.OnAck, FormatHistoryAck(Ack{State: "unavailable", ID: claim.ID}))
		w.Dispose()
		return &recorder{runID: claim.ID, scope: scope, state: &recorderState{}, getenv: opts.Getenv}, nil
	}
	emitAck(opts.OnAck, FormatHistoryAck(Ack{State: "claimed", ID: claim.ID}))
	rec := &recorder{writer: w, runID: claim.ID, scope: scope, state: &recorderState{}, getenv: opts.Getenv}
	rec.persistEntryYAML(opts.Workflow.File)
	return rec, nil
}

func (r *recorder) persistEntryYAML(path string) {
	if path == "" || r.writer == nil {
		return
	}
	body, err := os.ReadFile(path)
	if err != nil || len(body) == 0 {
		return
	}
	_ = WriteDebugArtifacts(r.runID, DebugArtifacts{EntryYAML: string(body)}, r.getenv)
}

// RecordTranscript stores the run's captured transcript for console debug views.
func (r *recorder) RecordTranscript(text string) {
	if r.writer == nil || text == "" {
		return
	}
	_ = WriteDebugArtifacts(r.runID, DebugArtifacts{Transcript: text}, r.getenv)
}

type claimError string

func (e claimError) Error() string { return string(e) }

func errClaim(msg string) error { return claimError(msg) }

func sourceOf(wf workflow.Definition) string {
	return wf.SourceKind()
}

func emitAck(fn func(string), line string) {
	if fn == nil {
		return
	}
	defer func() { _ = recover() }()
	fn(line)
}

func (r *recorder) RunID() string { return r.runID }

func (r *recorder) Child(scope engine.RecorderScope) engine.Recorder {
	return &recorder{writer: r.writer, runID: r.runID, scope: scope, state: r.state, getenv: r.getenv}
}

func (r *recorder) StepStarted(step workflow.Step, ordinal, total int, label string, phase engine.StepPhase) error {
	if r.writer == nil {
		return nil
	}
	if phase == "" {
		phase = engine.PhaseMain
	}
	r.writer.SetCurrentStep(CurrentStep{
		StepIdentity: stepBase(r.scope, step, ordinal, total, label, string(phase)),
		StartedAt:    nowISO(),
	})
	return nil
}

func (r *recorder) StepFinished(step workflow.Step, ordinal, total int, label string, kind engine.StepOutcomeKind, outcome *engine.RecorderOutcome, phase engine.StepPhase) error {
	if r.writer == nil {
		return nil
	}
	if phase == "" {
		phase = engine.PhaseMain
	}
	rec := StepRecord{
		StepIdentity: stepBase(r.scope, step, ordinal, total, label, string(phase)),
		FinishedAt:   nowISO(),
		Outcome:      string(kind),
	}
	if outcome != nil && outcome.OK && outcome.Truncated {
		rec.Truncated = true
	}
	if outcome != nil && !outcome.OK {
		rec.Failure = failureFact(step, outcome)
		if workflow.ActionKind(step.Action) != "workflow" {
			rec.Explanation = boundFailureExplanation(outcome.Error)
		}
	}
	r.writer.RecordStep(rec)
	return nil
}

func (r *recorder) Finished(status engine.RunTerminalStatus, extras *engine.RecorderFinishExtras) error {
	if r.state.finalized {
		return nil
	}
	r.state.finalized = true
	if r.writer == nil {
		return nil
	}
	opts := FinalizeOpts{}
	if extras != nil {
		opts.Returns = extras.Returns
		opts.Error = extras.Error
	}
	r.writer.Finalize(string(status), opts)
	return nil
}

func (r *recorder) Dispose() {
	if r.writer != nil {
		r.writer.Dispose()
	}
}

func stepBase(scope engine.RecorderScope, step workflow.Step, ordinal, total int, label, phase string) StepIdentity {
	id := StepIdentity{
		Phase:        phase,
		Workflow:     scope.Name,
		WorkflowPath: append([]string{}, scope.WorkflowPath...),
		Ordinal:      ordinal,
		Total:        total,
		Action:       workflow.ActionKind(step.Action),
		Label:        label,
	}
	if scope.ParentOrdinal != nil {
		n := *scope.ParentOrdinal
		id.ParentOrdinal = &n
	}
	if step.ID != "" {
		id.StepID = step.ID
	}
	return id
}

func failureFact(step workflow.Step, outcome *engine.RecorderOutcome) *FailureFact {
	kind := workflow.ActionKind(step.Action)
	fact := &FailureFact{Action: kind}
	if outcome.Details != nil {
		if v, ok := outcome.Details["exit_code"]; ok {
			switch n := v.(type) {
			case int:
				fact.ExitCode = &n
			case float64:
				i := int(n)
				fact.ExitCode = &i
			}
		}
		if s, ok := outcome.Details["verdict"].(string); ok {
			fact.Verdict = s
		}
		fact.Stream = streamName(outcome.Details)
	}
	if kind == "herdr" {
		switch a := step.Action.(type) {
		case workflow.HerdrAction:
			fact.Method = a.Method
		case *workflow.HerdrAction:
			fact.Method = a.Method
		}
	}
	if outcome.CoordinationLost {
		fact.Coordination = "lost"
	}
	if step.ID != "" {
		fact.StepID = step.ID
	}
	return fact
}

func streamName(details map[string]any) string {
	if s, ok := details["stream"].(string); ok && s != "" {
		return s
	}
	if s, ok := details["stderr"].(string); ok && strings.TrimSpace(s) != "" {
		return "stderr"
	}
	if s, ok := details["stdout"].(string); ok && strings.TrimSpace(s) != "" {
		return "stdout"
	}
	return ""
}
