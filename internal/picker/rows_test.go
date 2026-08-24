package picker

import (
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestBuildPickerOptionsTitleProvenanceAndSensitivity(t *testing.T) {
	// Ports test/picker/picker.test.ts "title, provenance, inputs, and sensitivity flags".
	entry := workflow.ListEntry{
		Name:             "handover",
		Source:           "repo",
		File:             "/r/handover.yaml",
		Title:            "Handover",
		Description:      "Pick a profile",
		Inputs:           []workflow.InputSpec{{Name: "target", Type: "profile", Options: []string{"claude"}}},
		HasCommands:      true,
		NeedsTranscript:  true,
		SensitiveMethods: []string{"pane.close"},
	}
	options := BuildPickerOptions([]workflow.ListEntry{entry}, 60)
	want := "  " + " " + padEndJS("Handover", 42) + "  " + "!" + "  " + padStartJS("repo", 7) + "   "
	if options[0].Name != want {
		t.Fatalf("row = %q, want %q", options[0].Name, want)
	}
	for _, forbidden := range []string{"inputs", "commands", "transcript", "herdr:pane.close"} {
		if strings.Contains(options[0].Name, forbidden) {
			t.Fatalf("row advertises %q: %q", forbidden, options[0].Name)
		}
	}
	if options[0].Description != "Pick a profile" {
		t.Fatalf("description = %q", options[0].Description)
	}
}

func TestFormatPickerRowWarningAndLocationColumns(t *testing.T) {
	// Ports warning-field, location pad, selected/unselected length, overlong title.
	warned := FormatPickerRowName("Warned", "repo", true, 60, false)
	clean := FormatPickerRowName("Clean", "repo", false, 60, false)
	if warned[47] != '!' {
		t.Fatalf("warned marker = %q at col 47", string(warned[47]))
	}
	if clean[47] != ' ' {
		t.Fatalf("clean marker = %q at col 47", string(clean[47]))
	}
	if !strings.HasSuffix(warned, padStartJS("repo", 7)+"   ") || !strings.HasSuffix(clean, padStartJS("repo", 7)+"   ") {
		t.Fatalf("location suffixes: %q %q", warned, clean)
	}
	row := FormatPickerRowName("A", "global", false, 60, false)
	if row[len(row)-10:] != padStartJS("global", 7)+"   " {
		t.Fatalf("global location = %q", row[len(row)-10:])
	}
	if got := FormatPickerRowName("A", "invalid", false, 60, false); got[len(got)-10:] != padStartJS("invalid", 7)+"   " {
		t.Fatalf("invalid location = %q", got[len(got)-10:])
	}
	selected := FormatPickerRowName("Handoff", "repo", true, 60, true)
	idle := FormatPickerRowName("Handoff", "repo", true, 60, false)
	if len(selected) != len(idle) {
		t.Fatalf("selected len %d idle %d", len(selected), len(idle))
	}
	if !strings.HasPrefix(selected, "> ") || !strings.HasPrefix(idle, "  ") {
		t.Fatalf("prefixes %q %q", selected, idle)
	}
	short := FormatPickerRowName("Short", "repo", true, 60, false)
	long := FormatPickerRowName(strings.Repeat("A", 80), "repo", true, 60, false)
	if len(long) != len(short) || long[len(long)-10:] != short[len(short)-10:] {
		t.Fatalf("overlong alignment long=%q short=%q", long, short)
	}
	if !strings.Contains(long, "...") {
		t.Fatalf("overlong missing ellipsis: %q", long)
	}
	choice := FormatPickerRowName("staging", "", false, 60, true)
	if tui.Columns(choice) != 60 {
		t.Fatalf("choice row cols %d want 60", tui.Columns(choice))
	}
}

func TestEntrySensitivityAggregatesFlags(t *testing.T) {
	// Ports test/picker/picker.test.ts "aggregates command transcript and sensitive methods".
	got := EntrySensitivity(workflow.ListEntry{
		Name:               "x",
		Source:             "repo",
		File:               "/x",
		HasCommands:        true,
		NeedsTranscript:    true,
		SensitiveMethods:   []string{"layout.apply"},
		UnresolvedChildren: []string{"missing"},
	})
	want := []string{"commands", "transcript", "herdr:layout.apply", "unresolved:missing"}
	if !stringSlicesEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	line := FormatConsentLine(workflow.ListEntry{
		Name: "deploy", Source: "global", Title: "Deploy", HasCommands: true, NeedsTranscript: true,
	})
	if line != "Deploy | global | commands | transcript" {
		t.Fatalf("consent = %q", line)
	}
	if FormatConsentLine(workflow.ListEntry{Name: "plain", Source: "repo"}) != "" {
		t.Fatal("plain workflow must omit consent")
	}
}

func TestFormatRuleSpansRowTextField(t *testing.T) {
	// Ports test/picker/picker.test.ts formatRule.
	rule := tui.FormatRule(60)
	if rule != "   "+strings.Repeat("-", 54)+"   " || len(rule) != 60 {
		t.Fatalf("rule(60) = %q", rule)
	}
	if tui.FormatRule(10) != "   "+strings.Repeat("-", 4)+"   " {
		t.Fatalf("rule(10) = %q", tui.FormatRule(10))
	}
	if strings.Count(rule, "-") != 60-2*tui.RowTextIndent {
		t.Fatalf("rule dash count = %d", strings.Count(rule, "-"))
	}
}

func padEndJS(s string, n int) string {
	if len(s) >= n {
		return s
	}
	return s + strings.Repeat(" ", n-len(s))
}

func padStartJS(s string, n int) string {
	if len(s) >= n {
		return s
	}
	return strings.Repeat(" ", n-len(s)) + s
}
