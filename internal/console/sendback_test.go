package console

import (
	"os"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
)

func TestFormatAnnotationBundleHandoff(t *testing.T) {
	fragments := map[string]string{
		"brief": "- id: brief\n  agent: handoff writer\n",
	}
	got := FormatAnnotationBundle("Handoff", []string{"brief"}, fragments, "tighten the focus line")
	for _, want := range []string{
		"Selected steps: brief",
		"--- brief ---",
		"id: brief",
		"--- instruction ---",
		"tighten the focus line",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("bundle missing %q:\n%s", want, got)
		}
	}
}

func TestMaybeSpillSendbackTextUnderCap(t *testing.T) {
	repo := t.TempDir()
	text := "small bundle"
	got, spill, err := MaybeSpillSendbackText(repo, text)
	if err != nil {
		t.Fatal(err)
	}
	if got != text {
		t.Fatalf("got %q, want unchanged", got)
	}
	if spill != "" {
		t.Fatalf("spill = %q, want empty for inline text", spill)
	}
}

func TestMaybeSpillSendbackTextOverCap(t *testing.T) {
	repo := t.TempDir()
	large := strings.Repeat("x", caps.AgentPromptByteLimit+64)
	got, spill, err := MaybeSpillSendbackText(repo, large)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "Read the absolute path ") {
		t.Fatalf("got %q, want spill instruction", got)
	}
	if strings.Contains(got, large[:80]) {
		t.Fatal("spilled text still contains bundle body")
	}
	if spill == "" || !strings.Contains(got, spill) {
		t.Fatalf("spill path %q not named in instruction %q", spill, got)
	}
	body, err := os.ReadFile(spill)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != large {
		t.Fatal("spill file content mismatch")
	}
}
