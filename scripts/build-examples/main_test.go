package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func examplesDir(t *testing.T) string {
	t.Helper()
	return filepath.Join("..", "..", "examples")
}

func TestExampleGalleryCards(t *testing.T) {
	cards, err := BuildExamples(examplesDir(t))
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, len(cards))
	for i, card := range cards {
		names[i] = card.Name
	}
	slices.Sort(names)
	want := []string{
		"adversarial-revise",
		"branch-check",
		"handoff",
		"prompt-enhance",
		"remote-branch-log",
		"review-gate",
		"worktree",
	}
	if !slices.Equal(names, want) {
		t.Fatalf("names = %v, want %v", names, want)
	}
	legacyOut := regexp.MustCompile(`(?m)^\s*out:`)
	legacyWait := regexp.MustCompile(`(?m)^\s*wait:`)
	legacyAllowFail := regexp.MustCompile(`(?m)^\s*allow_fail:`)
	legacyOnError := regexp.MustCompile(`(?m)^\s*on_error:`)
	legacyUse := regexp.MustCompile(`(?m)^\s*use:`)
	for _, card := range cards {
		if card.Desc == "" {
			t.Fatalf("%s: desc must be non-empty", card.Name)
		}
		if card.Payload == "" {
			t.Fatalf("%s: payload must be non-empty", card.Name)
		}
		if !strings.Contains(card.Body, "version: v1alpha1") {
			t.Fatalf("%s: body must contain version: v1alpha1", card.Name)
		}
		if legacyOut.MatchString(card.Body) {
			t.Fatalf("%s: body must not contain out:", card.Name)
		}
		if legacyWait.MatchString(card.Body) {
			t.Fatalf("%s: body must not contain wait:", card.Name)
		}
		if legacyAllowFail.MatchString(card.Body) {
			t.Fatalf("%s: body must not contain allow_fail:", card.Name)
		}
		if legacyOnError.MatchString(card.Body) {
			t.Fatalf("%s: body must not contain on_error:", card.Name)
		}
		if strings.Contains(card.Body, "{session}") {
			t.Fatalf("%s: body must not contain {session}", card.Name)
		}
		if legacyUse.MatchString(card.Body) {
			t.Fatalf("%s: body must not contain use: at line start", card.Name)
		}
	}
}

func TestCLIJSONOutput(t *testing.T) {
	repoRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("go", "run", "./scripts/build-examples")
	cmd.Dir = repoRoot
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("go run ./scripts/build-examples: %v\n%s", err, out)
	}
	var cards []ExampleCard
	if err := json.Unmarshal(out, &cards); err != nil {
		t.Fatalf("stdout is not JSON array: %v\n%s", err, out)
	}
	if len(cards) == 0 {
		t.Fatal("expected non-empty card list")
	}
	for _, card := range cards {
		if card.Name == "" || card.Desc == "" || card.Body == "" || card.Payload == "" {
			t.Fatalf("card missing field: %+v", card)
		}
	}
	_ = repoRoot
}

func TestDocsExamplesDataUsesGoHelper(t *testing.T) {
	path := filepath.Join("..", "..", "docs", ".vitepress", "theme", "examples.data.ts")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	if !strings.Contains(text, "go") || !strings.Contains(text, "./scripts/build-examples") {
		t.Fatalf("examples.data.ts must shell out to go run ./scripts/build-examples")
	}
	if strings.Contains(text, "build-examples.ts") {
		t.Fatalf("examples.data.ts must not import scripts/build-examples.ts")
	}
}
