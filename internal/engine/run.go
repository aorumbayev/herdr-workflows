package engine

import (
	"fmt"
	"regexp"
	"strings"
)

var runIDRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Run is the in-memory execution lifecycle for one workflow invocation.
type Run struct {
	id       string
	depth    int
	outcomes []StepOutcomeKind
	terminal *RunTerminalStatus
}

func ValidRunID(id string) bool {
	return runIDRe.MatchString(strings.ToLower(strings.TrimSpace(id)))
}

func ValidOutcomeKind(s string) bool {
	switch StepOutcomeKind(s) {
	case OutcomeSucceeded, OutcomeSkipped, OutcomeLaunched,
		OutcomeFailedContinued, OutcomeFailed, OutcomeInterrupted:
		return true
	default:
		return false
	}
}

func ValidTerminalStatus(s string) bool {
	switch RunTerminalStatus(s) {
	case StatusSucceeded, StatusFailed, StatusInterrupted:
		return true
	default:
		return false
	}
}

func NewRun(id string) (*Run, error) {
	normalized := strings.ToLower(strings.TrimSpace(id))
	if !runIDRe.MatchString(normalized) {
		return nil, fmt.Errorf("run id %q is not a canonical UUID", id)
	}
	return &Run{id: normalized}, nil
}

func (r *Run) ID() string { return r.id }

func (r *Run) HasCurrentStep() bool { return r.depth > 0 }

func (r *Run) TerminalStatus() (RunTerminalStatus, bool) {
	if r.terminal == nil {
		return "", false
	}
	return *r.terminal, true
}

func (r *Run) Outcomes() []StepOutcomeKind {
	out := make([]StepOutcomeKind, len(r.outcomes))
	copy(out, r.outcomes)
	return out
}

func (r *Run) StartStep() error {
	if r.terminal != nil {
		return fmt.Errorf("run is already terminal")
	}
	r.depth++
	return nil
}

func (r *Run) FinishStep(kind StepOutcomeKind) error {
	if r.terminal != nil {
		return fmt.Errorf("run is already terminal")
	}
	if !ValidOutcomeKind(string(kind)) {
		return fmt.Errorf("unknown step outcome kind %q", kind)
	}
	if kind == OutcomeSkipped {
		r.outcomes = append(r.outcomes, kind)
		return nil
	}
	if r.depth == 0 {
		return fmt.Errorf("no current step")
	}
	r.depth--
	r.outcomes = append(r.outcomes, kind)
	return nil
}

func (r *Run) Finish(status RunTerminalStatus) error {
	if r.terminal != nil {
		return fmt.Errorf("run is already terminal")
	}
	if r.depth > 0 {
		return fmt.Errorf("current step still in flight")
	}
	if !ValidTerminalStatus(string(status)) {
		return fmt.Errorf("unknown terminal status %q", status)
	}
	if err := r.checkFinishAgree(status); err != nil {
		return err
	}
	r.terminal = &status
	return nil
}

func (r *Run) checkFinishAgree(status RunTerminalStatus) error {
	hasInterrupted := false
	hasFailure := false
	for _, kind := range r.outcomes {
		switch kind {
		case OutcomeInterrupted:
			hasInterrupted = true
			hasFailure = true
		case OutcomeFailed, OutcomeFailedContinued:
			hasFailure = true
		}
	}
	switch status {
	case StatusSucceeded:
		if hasFailure {
			return fmt.Errorf("succeeded disagrees with outcomes")
		}
		return nil
	case StatusInterrupted:
		if !hasInterrupted {
			return fmt.Errorf("interrupted requires an interrupted outcome")
		}
		return nil
	case StatusFailed:
		if hasInterrupted {
			return fmt.Errorf("failed disagrees with interrupted outcome")
		}
		return nil
	default:
		return fmt.Errorf("unknown terminal status %q", status)
	}
}
