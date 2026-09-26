package engine

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"

	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

// ReusedStep is one top-level step that a resumed run takes from its source run.
type ReusedStep struct {
	Outcome StepOutcomeKind
	Result  any
}

// Resume starts a run at top-level step From. Reused holds steps 1..From-1.
type Resume struct {
	From   int
	Reused []ReusedStep
}

// RetrySourceStep is one recorded top-level main-phase step of a source run.
type RetrySourceStep struct {
	Ordinal   int
	StepID    string
	Outcome   StepOutcomeKind
	HasResult bool
	Result    any
}

// RetrySource is what a recorded run keeps so a later run can resume it.
type RetrySource struct {
	Fingerprints []string
	Steps        []RetrySourceStep
}

// StepFingerprints digests each top-level step. A workflow step digest covers its child graph.
func StepFingerprints(wf *workflow.Definition) []string {
	out := make([]string, len(wf.Steps))
	for i, step := range wf.Steps {
		out[i] = digest(stepShape(step, wf.Children, []string{wf.Name}))
	}
	return out
}

func stepShape(step workflow.Step, children map[string]*workflow.Definition, stack []string) map[string]any {
	shape := map[string]any{"kind": workflow.ActionKind(step.Action), "step": step}
	if a, ok := asAction[workflow.WorkflowAction](step.Action); ok {
		shape["child"] = definitionShape(children[a.Name], stack)
	}
	return shape
}

func definitionShape(def *workflow.Definition, stack []string) any {
	if def == nil || slices.Contains(stack, def.Name) {
		return nil
	}
	next := append(slices.Clone(stack), def.Name)
	steps := make([]any, len(def.Steps))
	for i, step := range def.Steps {
		steps[i] = stepShape(step, def.Children, next)
	}
	var onFailure any
	if def.OnFailure != nil {
		onFailure = map[string]any{"kind": workflow.ActionKind(def.OnFailure), "action": def.OnFailure}
	}
	return map[string]any{"name": def.Name, "inputs": def.Inputs, "returns": def.Returns, "on_failure": onFailure, "steps": steps}
}

func digest(v any) string {
	data, _ := json.Marshal(v)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func reusableOutcome(kind StepOutcomeKind) bool {
	return kind == OutcomeSucceeded || kind == OutcomeSkipped || kind == OutcomeLaunched
}

// PlanResume picks the first top-level step that did not finish well and checks
// that every step before it is unchanged and has its recorded result.
func PlanResume(wf *workflow.Definition, src RetrySource) (*Resume, error) {
	byOrdinal := make(map[int]RetrySourceStep, len(src.Steps))
	for _, step := range src.Steps {
		byOrdinal[step.Ordinal] = step
	}
	from := 1
	for ; from <= len(src.Fingerprints); from++ {
		step, ok := byOrdinal[from]
		if ok && step.Outcome == OutcomeLaunched {
			return nil, fmt.Errorf("step %d launched background work whose state cannot be replayed safely — retry all instead", from)
		}
		if !ok || !reusableOutcome(step.Outcome) {
			break
		}
	}
	if len(src.Fingerprints) > 0 && from > len(src.Fingerprints) {
		return nil, errors.New("nothing to resume: every step of the source run finished well — retry all instead")
	}
	current := StepFingerprints(wf)
	reused := make([]ReusedStep, 0, from-1)
	for n := 1; n < from; n++ {
		if n > len(current) {
			return nil, fmt.Errorf("step %d was removed since the source run — retry all instead", n)
		}
		step := wf.Steps[n-1]
		if current[n-1] != src.Fingerprints[n-1] {
			return nil, fmt.Errorf("step %d (%s) changed since the source run; only the failed step and later steps may change — retry all instead", n, stepLabel(step))
		}
		recorded := byOrdinal[n]
		if recorded.Outcome == OutcomeSucceeded && step.ID != "" && !recorded.HasResult {
			return nil, fmt.Errorf("result of step %d (%s) was not recorded — retry all instead", n, step.ID)
		}
		reused = append(reused, ReusedStep{Outcome: recorded.Outcome, Result: recorded.Result})
	}
	return &Resume{From: from, Reused: reused}, nil
}

func validateResume(wf *workflow.Definition, resume *Resume) string {
	if resume.From < 1 || resume.From > len(wf.Steps) || len(resume.Reused) != resume.From-1 {
		return fmt.Sprintf("resume point step %d does not fit this workflow of %d steps", resume.From, len(wf.Steps))
	}
	return ""
}

// checkReusedPanes confirms that each reused pane a remaining step names still exists.
func checkReusedPanes(wf *workflow.Definition, resume *Resume, deps RunnerDeps) string {
	ordinals := map[string]int{}
	for i := range resume.Reused {
		if id := wf.Steps[i].ID; id != "" {
			ordinals[id] = i + 1
		}
	}
	checked := map[string]bool{}
	for _, ref := range workflow.TemplateRefs(wf.Steps[resume.From-1:], wf.Returns, wf.OnFailure) {
		if ref.Root != "steps" || len(ref.Segments) < 2 || ref.Segments[1] != "pane_id" {
			continue
		}
		n, ok := ordinals[ref.Segments[0]]
		if !ok {
			continue
		}
		result, _ := resume.Reused[n-1].Result.(map[string]any)
		pane, _ := result["pane_id"].(string)
		if pane == "" || checked[pane] {
			continue
		}
		checked[pane] = true
		if deps.HerdrCall == nil {
			return fmt.Sprintf("pane %s from step %d (%s) cannot be checked without herdr — retry all instead", pane, n, ref.Segments[0])
		}
		if _, err := deps.HerdrCall("pane.get", map[string]any{"pane_id": pane}); err != nil {
			return fmt.Sprintf("pane %s from step %d (%s) is gone (%s) — retry all instead", pane, n, ref.Segments[0], err)
		}
	}
	return ""
}

func replayStep(opts StepRunOpts, step workflow.Step, n, total int, label string, reused ReusedStep, values workflow.TemplateNamespace) error {
	if reused.Outcome != OutcomeSkipped {
		if err := opts.Run.StartStep(); err != nil {
			return err
		}
	}
	if step.ID != "" && reused.Result != nil {
		values.Steps[step.ID] = reused.Result
	}
	emitProgress(opts, n, total, label, ProgressReused)
	if err := opts.Run.FinishStep(reused.Outcome); err != nil {
		return err
	}
	_ = opts.Recorder.StepFinished(step, n, total, label, reused.Outcome, &RecorderOutcome{OK: true, Reused: true, Result: reused.Result}, PhaseMain)
	return nil
}
