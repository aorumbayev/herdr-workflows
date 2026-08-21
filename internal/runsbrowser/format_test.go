package runsbrowser

import (
	"strconv"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

func isASCII(s string) bool {
	for _, r := range s {
		if r < 0x20 || r > 0x7E {
			return false
		}
	}
	return true
}

func testListItem(t *testing.T, partial history.Summary) history.Summary {
	t.Helper()
	item := history.Summary{
		DisplayID:    partial.ID[:8],
		Source:       "repo",
		CheckoutRoot: "/repo",
		Status:       "succeeded",
		StartedAt:    "2026-01-01T00:00:00.000Z",
		ElapsedMs:    1200,
	}
	if partial.DisplayID != "" {
		item.DisplayID = partial.DisplayID
	}
	if partial.Source != "" {
		item.Source = partial.Source
	}
	if partial.CheckoutRoot != "" {
		item.CheckoutRoot = partial.CheckoutRoot
	}
	if partial.Status != "" {
		item.Status = partial.Status
	}
	if partial.StartedAt != "" {
		item.StartedAt = partial.StartedAt
	}
	if partial.ElapsedMs != 0 {
		item.ElapsedMs = partial.ElapsedMs
	}
	item.ID = partial.ID
	item.Workflow = partial.Workflow
	item.Title = partial.Title
	item.Progress = partial.Progress
	return item
}

func TestFormatRunListEmpty(t *testing.T) {
	// Ports test/history/run-history.test.ts "empty states distinguish current, machine, and filter miss".
	if !strings.Contains(FormatRunListEmpty(RunListEmptyOpts{
		Scope: ScopeCurrent, HasMachineRuns: true, FilterActive: false,
	}), "Ctrl+G") {
		t.Fatal("current scope with machine runs should mention Ctrl+G")
	}
	if !strings.Contains(FormatRunListEmpty(RunListEmptyOpts{
		Scope: ScopeAll, HasMachineRuns: false, FilterActive: false,
	}), "no workflow has run yet") {
		t.Fatal("all scope without machine runs")
	}
	if got := FormatRunListEmpty(RunListEmptyOpts{
		Scope: ScopeCurrent, HasMachineRuns: true, FilterActive: true,
	}); got != "no matching runs" {
		t.Fatalf("filter miss = %q", got)
	}
	if got := FormatRunListEmpty(RunListEmptyOpts{Unavailable: true}); got != "run history unavailable" {
		t.Fatalf("unavailable = %q", got)
	}
	if got := FormatRunListEmpty(RunListEmptyOpts{
		Scope: ScopeAll, HasMachineRuns: true, FilterActive: false,
	}); got != "no runs" {
		t.Fatalf("all empty with machine runs = %q", got)
	}
}

func TestFormatRunRowNarrowTruncation(t *testing.T) {
	// Ports test/history/run-history.test.ts "narrow truncation keeps status".
	row := testListItem(t, history.Summary{
		ID:       "550e8400-e29b-41d4-a716-446655440000",
		Workflow: "workflow-with-a-very-long-name",
		Status:   "interrupted",
	})
	narrow := FormatRunRow(row, 20, FormatRunRowOpts{})
	want := "INTERRUPTED | . | 1s"
	if narrow != want {
		t.Fatalf("narrow = %q, want %q", narrow, want)
	}
	if len(narrow) > 20 {
		t.Fatalf("narrow length %d > 20", len(narrow))
	}
}

func TestRunsFooterASCII(t *testing.T) {
	// Ports test/picker/update-indicator.test.ts ASCII checks for runsFooter.
	for _, s := range []string{
		RunsFooter(ScopeCurrent, 0, 3),
		RunsFooter(ScopeAll, 0, 0),
	} {
		if !isASCII(s) {
			t.Fatalf("non-ASCII footer: %q", s)
		}
	}
	if !strings.Contains(RunsFooter(ScopeCurrent, 0, 3), "Current") {
		t.Fatal("current scope label")
	}
	if !strings.Contains(RunsFooter(ScopeAll, 0, 0), "All") {
		t.Fatal("all scope label")
	}
	if strings.Contains(RunsFooter(ScopeCurrent, 0, 0), "0/0") {
		t.Fatal("RunsFooter must not embed 0/0")
	}
	if got := RunsFooter(ScopeCurrent, 2, 5); strings.HasSuffix(got, "3/5") {
		t.Fatalf("RunsFooter must not embed position: %q", got)
	}
}

func TestRunDetailFooterASCII(t *testing.T) {
	// Ports test/picker/update-indicator.test.ts ASCII checks for runDetailFooter.
	for _, s := range []string{
		RunDetailFooter(true),
		RunDetailFooter(false),
	} {
		if !isASCII(s) {
			t.Fatalf("non-ASCII footer: %q", s)
		}
	}
	if !strings.Contains(RunDetailFooter(true), "w workbench") {
		t.Fatal("workbench hint when allowed")
	}
	if strings.Contains(RunDetailFooter(false), "w workbench") {
		t.Fatal("workbench hint when disallowed")
	}
}

func TestFormatRunDetailLinesEllipsisMapping(t *testing.T) {
	// Ports test/picker/update-indicator.test.ts "detail lines map the wire ellipsis to ASCII".
	blocks := []history.Block{
		{Kind: "head", Status: "FAILED", Title: "demo", DisplayID: "abc12345", Elapsed: "1s"},
		{Kind: "note", Text: "writer heartbeat stale - not a failure"},
		{
			Kind: "step", Depth: 0, Ordinal: 1, Total: 2, Label: "build", Outcome: "failed",
			Explanation: "…tail of a bounded explanation",
		},
	}
	mapped := FormatRunDetailLines(blocks, 120)
	for _, line := range mapped {
		if !isASCII(line) {
			t.Fatalf("non-ASCII line: %q", line)
		}
	}
	joined := strings.Join(mapped, "\n")
	if !strings.Contains(joined, "...tail of a bounded explanation") {
		t.Fatalf("missing ASCII ellipsis mapping: %q", joined)
	}
}

func TestFormatRunDetailLinesTruncatedRead(t *testing.T) {
	// Ports test/history/history-project.test.ts truncated step outcome.
	blocks := []history.Block{
		{
			Kind: "step", Depth: 0, Ordinal: 1, Total: 1, Label: "read",
			Outcome: "succeeded (truncated read)",
		},
	}
	lines := FormatRunDetailLines(blocks, 120)
	if !strings.Contains(strings.Join(lines, "\n"), "truncated read") {
		t.Fatalf("lines = %q", lines)
	}
}

func TestDetailLinesStartingAndUnavailable(t *testing.T) {
	// Ports test/history/run-history.test.ts starting vs history-unavailable.
	id := "550e8400-e29b-41d4-a716-446655440000"
	starting := DetailLines(DetailView{Kind: "starting", ID: id, Workflow: "demo"}, 80)
	if !strings.Contains(starting[0], "STARTING") {
		t.Fatalf("starting head = %q", starting[0])
	}
	unavailable := DetailLines(DetailView{
		Kind: "history-unavailable", ID: id, Workflow: "demo",
		Progress: []string{"[1/1] shell"}, Finished: "succeeded",
	}, 80)
	if !strings.Contains(unavailable[0], "HISTORY UNAVAILABLE") {
		t.Fatalf("unavailable head = %q", unavailable[0])
	}
	if !strings.Contains(unavailable[0], "SUCCEEDED") {
		t.Fatalf("unavailable status = %q", unavailable[0])
	}
}

func TestDetailLinesHistoryUnavailableEllipsis(t *testing.T) {
	// Ports test/picker/update-indicator.test.ts history-unavailable progress/message glyphs.
	id := "550e8400-e29b-41d4-a716-446655440000"
	lines := DetailLines(DetailView{
		Kind: "history-unavailable", ID: id, Workflow: "demo",
		Progress: []string{"[1/2] build…"}, Message: "…bounded failure",
	}, 120)
	for _, line := range lines {
		if !isASCII(line) {
			t.Fatalf("non-ASCII line: %q", line)
		}
	}
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "[1/2] build...") {
		t.Fatalf("progress mapping: %q", joined)
	}
	if !strings.Contains(joined, "...bounded failure") {
		t.Fatalf("message mapping: %q", joined)
	}
}

func TestScrollDetailLines(t *testing.T) {
	// Ports test/history/run-history.test.ts "detail scroll keeps a fixed viewport".
	lines := make([]string, 12)
	for i := range lines {
		lines[i] = "line " + strconv.Itoa(i)
	}
	firstVisible, _ := ScrollDetailLines(lines, 0, 6)
	if len(firstVisible) != 6 {
		t.Fatalf("first visible len = %d", len(firstVisible))
	}
	nextVisible, scroll := ScrollDetailLines(lines, 3, 6)
	if nextVisible[0] != "line 3" {
		t.Fatalf("scrolled first = %q", nextVisible[0])
	}
	if scroll != 3 {
		t.Fatalf("scroll = %d", scroll)
	}
}

func TestSelectedIndex(t *testing.T) {
	items := []history.Summary{
		{ID: "a", Workflow: "one"},
		{ID: "b", Workflow: "two"},
	}
	if SelectedIndex(items, "b") != 1 {
		t.Fatalf("found = %d", SelectedIndex(items, "b"))
	}
	if SelectedIndex(items, "missing") != 0 {
		t.Fatalf("missing = %d", SelectedIndex(items, "missing"))
	}
	if SelectedIndex(items, "") != 0 {
		t.Fatalf("empty id = %d", SelectedIndex(items, ""))
	}
}

func TestIsDetailPollableStatus(t *testing.T) {
	// Ports test/history/run-history.test.ts "detail poll targets only running and stale statuses".
	if !IsDetailPollableStatus("running") || !IsDetailPollableStatus("stale") {
		t.Fatal("running and stale pollable")
	}
	for _, status := range []string{"succeeded", "failed", "interrupted"} {
		if IsDetailPollableStatus(status) {
			t.Fatalf("%q should not poll", status)
		}
	}
}

func TestFormatRunListEmptyUsesChromeSep(t *testing.T) {
	got := FormatRunListEmpty(RunListEmptyOpts{
		Scope: ScopeCurrent, HasMachineRuns: true, FilterActive: false,
	})
	if !strings.Contains(got, tui.ChromeSep) {
		t.Fatalf("missing sep: %q", got)
	}
}

func TestDetailLinesLocalFailure(t *testing.T) {
	id := "550e8400-e29b-41d4-a716-446655440000"
	lines := DetailLines(DetailView{
		Kind: "local-failure", ID: id, Workflow: "demo", Message: "launch failed",
	}, 80)
	if len(lines) != 2 {
		t.Fatalf("lines = %v", lines)
	}
	if !strings.Contains(lines[0], "LAUNCH FAILED") {
		t.Fatalf("head = %q", lines[0])
	}
	for _, line := range lines {
		if !isASCII(line) {
			t.Fatalf("non-ASCII: %q", line)
		}
	}
}

func TestDetailLinesDetailWithProgress(t *testing.T) {
	blocks := []history.Block{
		{Kind: "head", Status: "RUNNING", Title: "demo", DisplayID: "abc12345", Elapsed: "1s"},
	}
	lines := DetailLines(DetailView{
		Kind: "detail", Blocks: blocks, Progress: []string{"[1/2] step…"},
	}, 120)
	if len(lines) < 3 {
		t.Fatalf("lines = %v", lines)
	}
	if lines[len(lines)-2] != "" {
		t.Fatalf("blank separator before progress: %q", lines[len(lines)-2])
	}
	if !strings.Contains(lines[len(lines)-1], "[1/2] step...") {
		t.Fatalf("progress line = %q", lines[len(lines)-1])
	}
}

func TestRunsFooterJoinsWithChromeSep(t *testing.T) {
	parts := strings.Split(RunsFooter(ScopeCurrent, 0, 3), tui.ChromeSep)
	if len(parts) != 4 {
		t.Fatalf("parts = %v", parts)
	}
	for _, part := range parts {
		if strings.Contains(part, "/") && part != "up/down scroll" {
			if part == "1/3" || part == "0/0" {
				t.Fatalf("RunsFooter must not embed position: %v", parts)
			}
		}
	}
}

func TestFormatRunDetailLinesStepIndent(t *testing.T) {
	blocks := []history.Block{
		{Kind: "step", Depth: 1, Ordinal: 2, Total: 3, Label: "nested", Outcome: "ok"},
	}
	lines := FormatRunDetailLines(blocks, 120)
	if !strings.HasPrefix(lines[0], "  2/3 nested") {
		t.Fatalf("indent = %q", lines[0])
	}
}
