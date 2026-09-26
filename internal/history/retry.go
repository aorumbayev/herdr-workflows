package history

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
	"github.com/aorumbayev/herdr-workflows/internal/engine"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

const artifactRetryPlan = "retry-plan"

// storedResult keeps a result, or the reason it could not be kept.
type storedResult struct {
	Value any    `json:"value"`
	Error string `json:"error,omitempty"`
}

type retryPlan struct {
	Error        string                           `json:"error,omitempty"`
	Inputs       map[string]string                `json:"inputs"`
	Domains      map[string][]string              `json:"domains,omitempty"`
	Fingerprints []string                         `json:"fingerprints"`
	Sources      map[string]workflow.FrozenSource `json:"sources"`
	Context      map[string]any                   `json:"context"`
}

// RetryRecord is what `hwf retry` needs from a recorded run. It is private and never shown.
type RetryRecord struct {
	ID           string
	Workflow     string
	CheckoutRoot string
	Status       string
	Inputs       map[string]string
	Domains      map[string][]string
	Sources      map[string]workflow.FrozenSource
	Context      map[string]any
	Source       engine.RetrySource
}

func resultArtifact(ordinal int) string {
	return "result/" + strconv.Itoa(ordinal)
}

func writeRetryPlan(id string, plan retryPlan) error {
	body, err := json.Marshal(plan)
	if err != nil {
		return err
	}
	if err := caps.AssertUnderCaptureCap("retry plan", string(body)); err != nil {
		body, _ = json.Marshal(retryPlan{Error: err.Error()})
	}
	db, err := openHistory()
	if err != nil {
		return err
	}
	return putArtifact(db, id, artifactRetryPlan, string(body))
}

func writeStepResult(id string, ordinal int, result any) error {
	body, err := json.Marshal(storedResult{Value: result})
	if err != nil {
		return err
	}
	if err := caps.AssertUnderCaptureCap(fmt.Sprintf("step %d result", ordinal), string(body)); err != nil {
		body, _ = json.Marshal(storedResult{Error: err.Error()})
	}
	db, err := openHistory()
	if err != nil {
		return err
	}
	return putArtifact(db, id, resultArtifact(ordinal), string(body))
}

// LoadRetryRecord reads the inputs, fingerprints, and top-level step results of one run.
func LoadRetryRecord(id string, now time.Time) (RetryRecord, error) {
	normalized, ok := NormalizeRunUUID(id)
	if !ok {
		return RetryRecord{}, errors.New("run id must be a complete UUID")
	}
	loaded, err := loadSnapshot(normalized)
	switch {
	case err != nil:
		return RetryRecord{}, fmt.Errorf("run history storage is unavailable: %w", err)
	case loaded.Expired:
		return RetryRecord{}, fmt.Errorf("run %s expired from history", normalized)
	case loaded.Incompatible != nil:
		return RetryRecord{}, fmt.Errorf("run %s has incompatible snapshot version %d", normalized, loaded.Incompatible.Version)
	case loaded.Snap == nil:
		return RetryRecord{}, fmt.Errorf("run %s not found in history", normalized)
	}
	snap := *loaded.Snap
	db, err := openHistory()
	if err != nil {
		return RetryRecord{}, err
	}
	body, ok, err := getArtifact(db, normalized, artifactRetryPlan)
	if err != nil {
		return RetryRecord{}, err
	}
	if !ok {
		return RetryRecord{}, fmt.Errorf("run %s has no retry data — it failed before inputs were collected or predates retry; start it with hwf run %s", normalized, snap.Workflow)
	}
	var plan retryPlan
	if err := json.Unmarshal([]byte(body), &plan); err != nil {
		return RetryRecord{}, fmt.Errorf("run %s retry data is unreadable: %w", normalized, err)
	}
	if plan.Error != "" {
		return RetryRecord{}, fmt.Errorf("run %s retry data was not recorded: %s", normalized, plan.Error)
	}
	if len(plan.Sources) == 0 || plan.Sources[snap.Workflow].YAML == "" || plan.Context == nil {
		return RetryRecord{}, fmt.Errorf("run %s lacks original workflow or context for a safe retry", normalized)
	}
	steps, err := topLevelSteps(db, snap)
	if err != nil {
		return RetryRecord{}, err
	}
	return RetryRecord{
		ID:           normalized,
		Workflow:     snap.Workflow,
		CheckoutRoot: snap.CheckoutRoot,
		Status:       ProjectStatus(snap, now),
		Inputs:       plan.Inputs,
		Domains:      plan.Domains,
		Sources:      plan.Sources,
		Context:      plan.Context,
		Source:       engine.RetrySource{Fingerprints: plan.Fingerprints, Steps: steps},
	}, nil
}

func topLevelSteps(db *sql.DB, snap Snapshot) ([]engine.RetrySourceStep, error) {
	var out []engine.RetrySourceStep
	for _, rec := range snap.Steps {
		if len(rec.WorkflowPath) != 1 || rec.Phase != string(engine.PhaseMain) {
			continue
		}
		step := engine.RetrySourceStep{Ordinal: rec.Ordinal, StepID: rec.StepID, Outcome: engine.StepOutcomeKind(rec.Outcome)}
		if rec.StepID != "" && step.Outcome == engine.OutcomeSucceeded {
			if err := loadStepResult(db, snap.ID, &step); err != nil {
				return nil, err
			}
		}
		out = append(out, step)
	}
	return out, nil
}

func loadStepResult(db *sql.DB, id string, step *engine.RetrySourceStep) error {
	body, ok, err := getArtifact(db, id, resultArtifact(step.Ordinal))
	if err != nil || !ok {
		return err
	}
	var stored storedResult
	if err := json.Unmarshal([]byte(body), &stored); err != nil {
		return fmt.Errorf("step %d result is unreadable: %w", step.Ordinal, err)
	}
	if stored.Error != "" {
		return fmt.Errorf("step %d result was not recorded: %s", step.Ordinal, stored.Error)
	}
	step.Result, step.HasResult = stored.Value, true
	return nil
}
