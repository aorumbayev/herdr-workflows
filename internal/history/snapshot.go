// Package history is Run Observation: it stores and presents Run Snapshot, Summary, and Detail without inventing state or exposing private execution data.
package history

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"strings"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/credentials"
	"github.com/aorumbayev/herdr-workflows/internal/engine"
)

const SnapshotVersion = 1

var isoLayouts = []string{time.RFC3339Nano, time.RFC3339}

type Snapshot struct {
	Version            int          `json:"version"`
	ID                 string       `json:"id"`
	Workflow           string       `json:"workflow"`
	Title              string       `json:"title,omitempty"`
	Source             string       `json:"source"`
	CheckoutRoot       string       `json:"checkout_root"`
	StartedAt          string       `json:"started_at"`
	HeartbeatAt        string       `json:"heartbeat_at"`
	FinishedAt         string       `json:"finished_at,omitempty"`
	CurrentStep        *CurrentStep `json:"current_step,omitempty"`
	Steps              []StepRecord `json:"steps"`
	Status             string       `json:"status,omitempty"`
	FailureExplanation string       `json:"failure_explanation,omitempty"`
	Returns            any          `json:"returns,omitempty"`
}

type StepIdentity struct {
	Phase         string   `json:"phase"`
	Workflow      string   `json:"workflow"`
	WorkflowPath  []string `json:"workflow_path"`
	Ordinal       int      `json:"ordinal"`
	Total         int      `json:"total"`
	ParentOrdinal *int     `json:"parent_ordinal,omitempty"`
	StepID        string   `json:"step_id,omitempty"`
	Action        string   `json:"action"`
	Label         string   `json:"label"`
}

type StepRecord struct {
	StepIdentity
	StartedAt   string       `json:"started_at,omitempty"`
	FinishedAt  string       `json:"finished_at"`
	Outcome     string       `json:"outcome"`
	Truncated   bool         `json:"truncated,omitempty"`
	Failure     *FailureFact `json:"failure,omitempty"`
	Explanation string       `json:"explanation,omitempty"`
}

type CurrentStep struct {
	StepIdentity
	StartedAt string `json:"started_at"`
}

type FailureFact struct {
	Action       string `json:"action"`
	ExitCode     *int   `json:"exit_code,omitempty"`
	Method       string `json:"method,omitempty"`
	Coordination string `json:"coordination,omitempty"`
	StepID       string `json:"step_id,omitempty"`
}

func IsSnapshot(v any) bool {
	_, ok := parseSnapshotValue(v)
	return ok
}

func parseSnapshotValue(v any) (Snapshot, bool) {
	m, ok := v.(map[string]any)
	if !ok {
		return Snapshot{}, false
	}
	version, ok := jsonInt(m["version"])
	if !ok || version != SnapshotVersion {
		return Snapshot{}, false
	}
	id, ok := asString(m["id"])
	if !ok || !engine.ValidRunID(id) {
		return Snapshot{}, false
	}
	workflow, ok := nonemptyString(m["workflow"])
	if !ok {
		return Snapshot{}, false
	}
	source, ok := asString(m["source"])
	if !ok || (source != "repo" && source != "global") {
		return Snapshot{}, false
	}
	checkout, ok := nonemptyString(m["checkout_root"])
	if !ok {
		return Snapshot{}, false
	}
	started, ok := isoString(m["started_at"])
	if !ok {
		return Snapshot{}, false
	}
	heartbeat, ok := isoString(m["heartbeat_at"])
	if !ok {
		return Snapshot{}, false
	}
	rawSteps, ok := m["steps"].([]any)
	if !ok {
		return Snapshot{}, false
	}
	steps := make([]StepRecord, 0, len(rawSteps))
	for _, raw := range rawSteps {
		step, ok := parseStepRecord(raw)
		if !ok {
			return Snapshot{}, false
		}
		steps = append(steps, step)
	}

	snap := Snapshot{
		Version:      version,
		ID:           strings.ToLower(strings.TrimSpace(id)),
		Workflow:     workflow,
		Source:       source,
		CheckoutRoot: checkout,
		StartedAt:    started,
		HeartbeatAt:  heartbeat,
		Steps:        steps,
	}
	if title, exists := m["title"]; exists {
		s, ok := asString(title)
		if !ok {
			return Snapshot{}, false
		}
		snap.Title = s
	}
	if expl, exists := m["failure_explanation"]; exists {
		s, ok := asString(expl)
		if !ok {
			return Snapshot{}, false
		}
		snap.FailureExplanation = s
	}
	if ret, exists := m["returns"]; exists {
		snap.Returns = ret
	}

	_, hasStatus := m["status"]
	_, hasFinished := m["finished_at"]
	_, hasCurrent := m["current_step"]
	if !applyTerminalFields(&snap, m, hasStatus, hasFinished, hasCurrent) {
		return Snapshot{}, false
	}
	if hasCurrent {
		cur, ok := parseCurrentStep(m["current_step"])
		if !ok {
			return Snapshot{}, false
		}
		snap.CurrentStep = &cur
	}
	return snap, true
}

func applyTerminalFields(snap *Snapshot, m map[string]any, hasStatus, hasFinished, hasCurrent bool) bool {
	switch {
	case hasStatus && (!hasFinished || hasCurrent):
		return false
	case !hasStatus && hasFinished:
		return false
	}
	if hasStatus {
		status, ok := asString(m["status"])
		if !ok || !engine.ValidTerminalStatus(status) {
			return false
		}
		snap.Status = status
	}
	if hasFinished {
		finished, ok := isoString(m["finished_at"])
		if !ok {
			return false
		}
		snap.FinishedAt = finished
	}
	return true
}

func parseStepIdentity(v any) (StepIdentity, bool) {
	m, ok := v.(map[string]any)
	if !ok {
		return StepIdentity{}, false
	}
	phase, ok := asString(m["phase"])
	if !ok || (phase != "main" && phase != "recovery") {
		return StepIdentity{}, false
	}
	workflow, ok := nonemptyString(m["workflow"])
	if !ok {
		return StepIdentity{}, false
	}
	rawPath, ok := m["workflow_path"].([]any)
	if !ok {
		return StepIdentity{}, false
	}
	path := make([]string, 0, len(rawPath))
	for _, p := range rawPath {
		s, ok := asString(p)
		if !ok {
			return StepIdentity{}, false
		}
		path = append(path, s)
	}
	ordinal, ok := jsonInt(m["ordinal"])
	if !ok || ordinal < 1 {
		return StepIdentity{}, false
	}
	total, ok := jsonInt(m["total"])
	if !ok || total < 1 || ordinal > total {
		return StepIdentity{}, false
	}
	action, ok := asString(m["action"])
	if !ok || !isActionKind(action) {
		return StepIdentity{}, false
	}
	label, ok := asString(m["label"])
	if !ok {
		return StepIdentity{}, false
	}
	id := StepIdentity{
		Phase:        phase,
		Workflow:     workflow,
		WorkflowPath: path,
		Ordinal:      ordinal,
		Total:        total,
		Action:       action,
		Label:        label,
	}
	if sid, exists := m["step_id"]; exists {
		s, ok := asString(sid)
		if !ok {
			return StepIdentity{}, false
		}
		id.StepID = s
	}
	nested := len(path) > 1
	parent, hasParent := m["parent_ordinal"]
	if nested {
		if !hasParent {
			return StepIdentity{}, false
		}
		n, ok := jsonInt(parent)
		if !ok || n < 1 {
			return StepIdentity{}, false
		}
		id.ParentOrdinal = &n
	} else if hasParent {
		return StepIdentity{}, false
	}
	return id, true
}

func parseStepRecord(v any) (StepRecord, bool) {
	m, ok := v.(map[string]any)
	if !ok {
		return StepRecord{}, false
	}
	ident, ok := parseStepIdentity(m)
	if !ok {
		return StepRecord{}, false
	}
	finished, ok := isoString(m["finished_at"])
	if !ok {
		return StepRecord{}, false
	}
	outcome, ok := asString(m["outcome"])
	if !ok || !engine.ValidOutcomeKind(outcome) {
		return StepRecord{}, false
	}
	rec := StepRecord{StepIdentity: ident, FinishedAt: finished, Outcome: outcome}
	if started, exists := m["started_at"]; exists {
		s, ok := isoString(started)
		if !ok {
			return StepRecord{}, false
		}
		rec.StartedAt = s
	}
	if truncated, exists := m["truncated"]; exists {
		b, ok := truncated.(bool)
		if !ok || !b {
			return StepRecord{}, false
		}
		rec.Truncated = true
	}
	if failure, exists := m["failure"]; exists {
		fact, ok := parseFailureFact(failure)
		if !ok {
			return StepRecord{}, false
		}
		rec.Failure = &fact
	}
	if expl, exists := m["explanation"]; exists {
		s, ok := asString(expl)
		if !ok {
			return StepRecord{}, false
		}
		rec.Explanation = s
	}
	return rec, true
}

func parseCurrentStep(v any) (CurrentStep, bool) {
	m, ok := v.(map[string]any)
	if !ok {
		return CurrentStep{}, false
	}
	ident, ok := parseStepIdentity(m)
	if !ok {
		return CurrentStep{}, false
	}
	started, ok := isoString(m["started_at"])
	if !ok {
		return CurrentStep{}, false
	}
	return CurrentStep{StepIdentity: ident, StartedAt: started}, true
}

func parseFailureFact(v any) (FailureFact, bool) {
	m, ok := v.(map[string]any)
	if !ok {
		return FailureFact{}, false
	}
	action, ok := asString(m["action"])
	if !ok || !isActionKind(action) {
		return FailureFact{}, false
	}
	fact := FailureFact{Action: action}
	if code, exists := m["exit_code"]; exists {
		n, ok := jsonInt(code)
		if !ok {
			return FailureFact{}, false
		}
		fact.ExitCode = &n
	}
	if method, exists := m["method"]; exists {
		s, ok := asString(method)
		if !ok {
			return FailureFact{}, false
		}
		fact.Method = s
	}
	if coord, exists := m["coordination"]; exists {
		s, ok := asString(coord)
		if !ok {
			return FailureFact{}, false
		}
		fact.Coordination = s
	}
	if sid, exists := m["step_id"]; exists {
		s, ok := asString(sid)
		if !ok {
			return FailureFact{}, false
		}
		fact.StepID = s
	}
	return fact, true
}

func isActionKind(s string) bool {
	return s == "agent" || s == "run" || s == "herdr" || s == "workflow"
}

func asString(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok
}

func nonemptyString(v any) (string, bool) {
	s, ok := asString(v)
	if !ok || s == "" {
		return "", false
	}
	return s, true
}

func isoString(v any) (string, bool) {
	s, ok := asString(v)
	if !ok || !isISOTimestamp(s) {
		return "", false
	}
	return s, true
}

func isISOTimestamp(s string) bool {
	for _, layout := range isoLayouts {
		if _, err := time.Parse(layout, s); err == nil {
			return true
		}
	}
	return false
}

func jsonInt(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		if math.Trunc(n) != n {
			return 0, false
		}
		return int(n), true
	case int:
		return n, true
	case int64:
		return int(n), true
	default:
		return 0, false
	}
}

type snapshotLoad struct {
	Snap         *Snapshot
	Incompatible *IncompatibleSnapshot
}

func ReadSnapshot(id string, getenv config.Env) (*Snapshot, error) {
	loaded, err := loadSnapshot(id, getenv)
	if err != nil {
		return nil, err
	}
	return loaded.Snap, nil
}

func loadSnapshot(id string, getenv config.Env) (snapshotLoad, error) {
	normalized, ok := NormalizeRunUUID(id)
	if !ok {
		return snapshotLoad{}, nil
	}
	if _, err := ensureRunsDir(getenv); err != nil {
		return snapshotLoad{}, err
	}
	if err := credentials.AssertPrivateCredentialFile(SnapshotPath(normalized, getenv), historyACLOpts()); err != nil {
		var store *credentials.StoreError
		if errors.As(err, &store) {
			return snapshotLoad{}, err
		}
		return snapshotLoad{}, nil
	}
	raw, err := os.ReadFile(SnapshotPath(normalized, getenv))
	if err != nil {
		return snapshotLoad{}, nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return snapshotLoad{}, nil
	}
	if version, ok := peekSnapshotVersion(v); ok && version != SnapshotVersion {
		return snapshotLoad{Incompatible: &IncompatibleSnapshot{ID: normalized, Version: version}}, nil
	}
	snap, ok := parseSnapshotValue(v)
	if !ok || snap.ID != normalized {
		return snapshotLoad{}, nil
	}
	return snapshotLoad{Snap: &snap}, nil
}

func peekSnapshotVersion(v any) (int, bool) {
	m, ok := v.(map[string]any)
	if !ok {
		return 0, false
	}
	return jsonInt(m["version"])
}
