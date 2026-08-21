package workflow

import (
	"strings"
	"testing"
)

func TestParseVerdict(t *testing.T) {
	oneOf := []string{"APPROVE", "REJECT", "NEEDS_WORK"}

	verdict, ok, line := ParseVerdict("Reasoning about the diff.\n\nAPPROVE\n", oneOf)
	if !ok || verdict != "APPROVE" || line != "" {
		t.Fatalf("parse verdict = %q, %v, %q", verdict, ok, line)
	}

	verdict, ok, line = ParseVerdict("APPROVE — with reservations\n", oneOf)
	if ok || line != "APPROVE — with reservations" {
		t.Fatalf("decorated verdict = %q, %v, %q", verdict, ok, line)
	}

	verdict, ok, line = ParseVerdict("\n  \n", oneOf)
	if ok || line != "" {
		t.Fatalf("empty verdict = %q, %v, %q", verdict, ok, line)
	}
}

func TestVerdictMismatchMessage(t *testing.T) {
	got := VerdictMismatchMessage("APPROVE — with reservations", []string{"APPROVE", "REJECT"})
	want := `final non-empty line "APPROVE — with reservations" is not a verdict token — expected exactly one of: APPROVE, REJECT`
	if got != want {
		t.Fatalf("mismatch message = %q, want %q", got, want)
	}

	got = VerdictMismatchMessage("", []string{"APPROVE"})
	if got != "final non-empty line an empty response is not a verdict token — expected exactly one of: APPROVE" {
		t.Fatalf("empty mismatch message = %q", got)
	}

	if !strings.Contains(VerdictMismatchMessage("\x01", []string{"DONE"}), `"\u0001"`) {
		t.Fatalf("control char must use JSON escaping, got %q", VerdictMismatchMessage("\x01", []string{"DONE"}))
	}
}

func TestVerdictNotRequiredMessage(t *testing.T) {
	got := VerdictNotRequiredMessage("REJECT", []string{"APPROVE", "NEEDS_WORK"})
	if got != "verdict REJECT is not accepted — this step requires one of: APPROVE, NEEDS_WORK" {
		t.Fatalf("not-required message = %q", got)
	}
}

func TestParseVerdictTokens(t *testing.T) {
	tokens, err := ParseVerdictTokens("APPROVE,REJECT, NEEDS_WORK")
	if err != nil || !slicesEqual(tokens, []string{"APPROVE", "REJECT", "NEEDS_WORK"}) {
		t.Fatalf("tokens = %v, err = %v", tokens, err)
	}

	if _, err := ParseVerdictTokens("approve"); err == nil || !strings.Contains(err.Error(), "invalid verdict token") {
		t.Fatalf("lowercase token err = %v", err)
	}
	if _, err := ParseVerdictTokens("APPROVE,APPROVE"); err == nil || !strings.Contains(err.Error(), "duplicate verdict token 'APPROVE'") {
		t.Fatalf("duplicate token err = %v", err)
	}
	if _, err := ParseVerdictTokens(" , "); err == nil || !strings.Contains(err.Error(), "at least one verdict token") {
		t.Fatalf("blank token err = %v", err)
	}
}

func TestParseVerdictTokensValidatesBeforeDuplicates(t *testing.T) {
	_, err := ParseVerdictTokens("APPROVE,APPROVE,invalid")
	if err == nil || !strings.Contains(err.Error(), "invalid verdict token 'invalid'") {
		t.Fatalf("precedence err = %v", err)
	}
}
