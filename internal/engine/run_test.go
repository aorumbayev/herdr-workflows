package engine

import (
	"strings"
	"testing"
)

func TestRunIsExecutableAggregate(t *testing.T) {
	var run *Run
	got, err := NewRun(fakeRunID)
	if err != nil {
		t.Fatalf("NewRun: %v", err)
	}
	run = got
	if run.ID() != fakeRunID {
		t.Fatalf("ID() = %q, want %q", run.ID(), fakeRunID)
	}
	if run.HasCurrentStep() {
		t.Fatal("new Run must have no current step")
	}
	if _, ok := run.TerminalStatus(); ok {
		t.Fatal("new Run must not be terminal")
	}
	if n := len(run.Outcomes()); n != 0 {
		t.Fatalf("Outcomes() len = %d, want 0", n)
	}
}

func TestNewRunRejectsNonCanonicalID(t *testing.T) {
	_, err := NewRun("not-a-uuid")
	if err == nil {
		t.Fatal("NewRun(non-canonical) error = nil")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "run id") {
		t.Fatalf("error = %q, want to name run id", err.Error())
	}
}

func TestRunRejectsContradictoryTransitions(t *testing.T) {
	run, err := NewRun(fakeRunID)
	if err != nil {
		t.Fatal(err)
	}
	ref := StepRef{Ordinal: 1, Total: 2, Label: "run: true", Phase: PhaseMain}
	if err := run.StartStep(ref); err != nil {
		t.Fatalf("StartStep: %v", err)
	}
	if !run.HasCurrentStep() {
		t.Fatal("StartStep must set current step")
	}
	if err := run.Finish(StatusFailed); err == nil {
		t.Fatal("Finish while current step error = nil")
	}
	child := StepRef{Ordinal: 1, Total: 1, Label: "run: child", Phase: PhaseMain}
	if err := run.StartStep(child); err != nil {
		t.Fatalf("nested StartStep: %v", err)
	}
	if err := run.FinishStep(OutcomeSucceeded); err != nil {
		t.Fatalf("nested FinishStep: %v", err)
	}
	if !run.HasCurrentStep() {
		t.Fatal("parent step must remain current after nested finish")
	}
	if err := run.FinishStep(OutcomeSucceeded); err != nil {
		t.Fatalf("FinishStep: %v", err)
	}
	if run.HasCurrentStep() {
		t.Fatal("FinishStep must clear current step")
	}
	if got := run.Outcomes(); len(got) != 2 || got[0] != OutcomeSucceeded || got[1] != OutcomeSucceeded {
		t.Fatalf("Outcomes() = %v, want two succeeded", got)
	}
	if err := run.FinishStep(OutcomeFailed); err == nil {
		t.Fatal("FinishStep without current (non-skip) error = nil")
	}
	if err := run.FinishStep(OutcomeSkipped); err != nil {
		t.Fatalf("skip without current: %v", err)
	}
	if err := run.Finish(StatusSucceeded); err != nil {
		t.Fatalf("Finish succeeded after success and skip: %v", err)
	}
}

func TestRunFinishSucceededRejectsFailedOutcomes(t *testing.T) {
	run, err := NewRun(fakeRunID)
	if err != nil {
		t.Fatal(err)
	}
	if err := run.FinishStep(OutcomeSkipped); err != nil {
		t.Fatal(err)
	}
	if err := run.StartStep(StepRef{Ordinal: 2, Total: 2, Label: "run: false", Phase: PhaseMain}); err != nil {
		t.Fatal(err)
	}
	if err := run.FinishStep(OutcomeFailedContinued); err != nil {
		t.Fatal(err)
	}
	if err := run.Finish(StatusSucceeded); err == nil {
		t.Fatal("Finish succeeded with failed_continued error = nil")
	}
	if err := run.Finish(StatusFailed); err != nil {
		t.Fatalf("Finish failed: %v", err)
	}
	if got, ok := run.TerminalStatus(); !ok || got != StatusFailed {
		t.Fatalf("TerminalStatus() = %q, %v, want %s true", got, ok, StatusFailed)
	}
	if err := run.StartStep(StepRef{Ordinal: 1, Total: 1, Label: "x", Phase: PhaseMain}); err == nil {
		t.Fatal("StartStep after terminal error = nil")
	}
	if err := run.Finish(StatusFailed); err == nil {
		t.Fatal("second Finish error = nil")
	}
}

func TestRunFinishInterruptedRequiresInterruptedOutcome(t *testing.T) {
	run, err := NewRun(fakeRunID)
	if err != nil {
		t.Fatal(err)
	}
	if err := run.StartStep(StepRef{Ordinal: 1, Total: 1, Label: "herdr", Phase: PhaseMain}); err != nil {
		t.Fatal(err)
	}
	if err := run.FinishStep(OutcomeInterrupted); err != nil {
		t.Fatal(err)
	}
	if err := run.Finish(StatusFailed); err == nil {
		t.Fatal("Finish failed with interrupted outcome error = nil")
	}
	if err := run.Finish(StatusInterrupted); err != nil {
		t.Fatalf("Finish interrupted: %v", err)
	}
}

func TestValidOutcomeAndTerminalVocabulary(t *testing.T) {
	for _, kind := range []string{
		"succeeded", "skipped", "launched", "failed_continued", "failed", "interrupted",
	} {
		if !ValidOutcomeKind(kind) {
			t.Fatalf("ValidOutcomeKind(%q) = false", kind)
		}
	}
	if ValidOutcomeKind("ok") {
		t.Fatal("ValidOutcomeKind(ok) = true, ProgressOutcome must not be execution vocabulary")
	}
	for _, status := range []string{"succeeded", "failed", "interrupted"} {
		if !ValidTerminalStatus(status) {
			t.Fatalf("ValidTerminalStatus(%q) = false", status)
		}
	}
	if ValidTerminalStatus("stale") {
		t.Fatal("ValidTerminalStatus(stale) = true, stale is a projection not a terminal status")
	}
	if !ValidRunID(fakeRunID) {
		t.Fatal("ValidRunID(fakeRunID) = false")
	}
	if ValidRunID("not-a-uuid") {
		t.Fatal("ValidRunID(not-a-uuid) = true")
	}
}
