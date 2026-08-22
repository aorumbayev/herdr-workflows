package picker

import (
	"os"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

// Spec scenarios owned by picker.ParityBaseline (picker-presentation + picker-editor-actions).
// openspec/specs/picker-presentation/spec.md
// openspec/specs/picker-editor-actions/spec.md
var requiredPickerParityScenarios = []string{
	"Title appears only in the pane label",
	"No runtime retitling",
	"More workflows than the viewport",
	"Cursor moves beyond the viewport",
	"Fewer matches than the viewport",
	"Sensitive workflow",
	"Unbounded flag list does not widen the row",
	"Overlong title",
	"Inputs are not advertised in the row",
	"Flags shown before run",
	"Warnings are not the least legible element",
	"Repository with a broken workflow file",
	"Selecting an invalid workflow",
	"Long description wraps instead of cropping",
	"Description too long for two lines",
	"Cursor moves",
	"Rule does not touch the border",
	"Hint is not clipped",
	"Position counter reflects the filtered list",
	"No scroll thumb",
	"Regular list footer",
	"Filtering by displayed title",
	"Filtering by name",
	"Case is ignored",
	"Narrow host pane",
	"Width changes mid-session",
	"CJK locale",
	"Font without box or arrow glyphs",
	"Charm flush-left filter without slash prefix",
	"ASCII greater-than cursor on choice option rows",
	"Correct the final answer",
	"Mode change alters active inputs",
	"Failed run navigation",
	"Dropdown of many options",
	"Undescribed input",
	"Custom value accepted",
	"Constrained text input",
	"Unresolved dynamic domain",
	"Title row keeps named sensitivity flags",
	"A guarded domain is explained by an earlier answer",
	"First prompt has no answers",
	"Answers exceed the popup width",
	"Backward navigation drops later answers",
	"Hotkey with no workflows",
	"Empty footer",
	"No matches for filter",
	"Workflow filter has text",
	"Input collection",
	"Return to workflows",
	"Child acknowledges start",
	"Child cannot record history",
	"Child fails before claim",
	"Fast successful workflow",
	"Leave an active launch",
	"Newer release appears after mount",
	"Update service is unavailable",
	"Draft is not advertised",
	"Open palette",
	"Printable k filters",
	"Escape closes palette",
	"New from empty catalog",
	"Import from empty catalog",
	"Browse examples",
	"Open repo workflow",
	"Open without selection",
	"Share copies command",
	"Share stays in picker",
	"Confirmed delete",
	"Cancel delete",
}

func TestParityBaselineCoversSpecScenarios(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md
	// openspec/specs/picker-editor-actions/spec.md
	byScenario := make(map[string]ParitySurface, len(ParityBaseline()))
	for _, row := range ParityBaseline() {
		if row.Scenario == "" {
			t.Fatal("parity row missing Scenario")
		}
		if _, dup := byScenario[row.Scenario]; dup {
			t.Fatalf("duplicate parity scenario %q", row.Scenario)
		}
		byScenario[row.Scenario] = row
	}
	for _, scenario := range requiredPickerParityScenarios {
		row, ok := byScenario[scenario]
		if !ok {
			t.Errorf("missing Go parity row for scenario %q", scenario)
			continue
		}
		if row.GoSurface == "" {
			t.Errorf("scenario %q missing GoSurface", scenario)
		}
		if row.CoveringTest == "" {
			t.Errorf("scenario %q missing CoveringTest", scenario)
		}
		if row.Spec == "" || row.Requirement == "" || row.Kind == "" {
			t.Errorf("scenario %q incomplete metadata: %+v", scenario, row)
		}
	}
	for scenario := range byScenario {
		found := false
		for _, want := range requiredPickerParityScenarios {
			if want == scenario {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("unexpected parity scenario %q not in picker-owned spec list", scenario)
		}
	}
}

func TestParityFewerMatchesPadBlankRows(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md "Fewer matches than the viewport"
	m := New(Options{Entries: eightEntries()[:2], Width: 62})
	body := m.View().Content
	lines := strings.Split(body, "\n")
	blank := 0
	for _, line := range lines {
		if tui.StripContentPadding(line) == "" {
			blank++
		}
	}
	if listRowCount(body) != 2 {
		t.Fatalf("visible named rows = %d, want 2\n%s", listRowCount(body), body)
	}
	if blank < 6 {
		t.Fatalf("expected blank pad rows, blank=%d\n%s", blank, body)
	}
	if !strings.Contains(body, tui.ListHint) {
		t.Fatalf("footer missing:\n%s", body)
	}
}

func TestParityInvalidRowDetailShowsLoadError(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md "Selecting an invalid workflow"
	m := New(Options{Entries: catalogEntries(), Width: 80})
	for m.cursor < len(m.matched())-1 {
		entry := m.matched()[m.cursor].Entry
		if entry.Error != "" {
			break
		}
		m = apply(m, "down")
	}
	sel := m.selectedEntry()
	if sel == nil || sel.Error == "" {
		t.Fatal("expected invalid row selected")
	}
	body := m.View().Content
	if !strings.Contains(body, "invalid") {
		t.Fatalf("missing invalid location:\n%s", body)
	}
	if !strings.Contains(body, "unknown agent") && !strings.Contains(body, StripFilePrefix(sel.Error, sel.File)) {
		t.Fatalf("detail missing load error:\n%s", body)
	}
}

func TestParityPositionCounterUsesFilteredList(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md "Position counter reflects the filtered list"
	m := New(Options{Entries: eightEntries(), Width: 80})
	m = apply(m, "a", "l", "p", "h", "a")
	body := m.View().Content
	if !strings.HasSuffix(strings.TrimSpace(strings.Split(body, "\n")[len(strings.Split(body, "\n"))-1]), "1/1") &&
		!strings.Contains(body, "1/1") {
		t.Fatalf("counter missing 1/1:\n%s", body)
	}
}

func TestParityNoScrollThumbGlyph(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md "No scroll thumb"
	m := New(Options{Entries: eightEntries(), Width: 62})
	body := m.View().Content
	for _, glyph := range []string{"▐", "█", "▓", "░", "▲", "▼", "┃"} {
		if strings.Contains(body, glyph) {
			t.Fatalf("scroll thumb glyph %q present:\n%s", glyph, body)
		}
	}
}

func TestParityListFooterIdentifiesRunCtrlKDismiss(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md "Regular list footer"
	m := New(Options{Entries: catalogEntries(), Width: 80})
	body := m.View().Content
	if !strings.Contains(body, "enter run") || !strings.Contains(body, "ctrl+k") || !strings.Contains(body, "esc") {
		t.Fatalf("footer hints:\n%s", body)
	}
}

func TestParityWidthChangeRecomputesTruncation(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md "Width changes mid-session"
	m := New(Options{Entries: eightEntries(), Width: 80})
	wide := m.View().Content
	next, _ := m.Update(tea.WindowSizeMsg{Width: 40})
	m = next.(Model)
	narrow := m.View().Content
	if m.width != 40 {
		t.Fatalf("width = %d", m.width)
	}
	for _, line := range strings.Split(narrow, "\n") {
		if tui.Columns(line) > 40 {
			t.Fatalf("line wider than width: %q", line)
		}
	}
	if wide == narrow {
		t.Fatal("width change must recompute render")
	}
}

func TestParityModeChangeDiscardsLaterAnswers(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md "Mode change alters active inputs"
	entry := workflow.WorkflowListEntry{Name: "gated", Source: "repo", File: "/r/gated.yaml"}
	m := New(Options{
		Entries: []workflow.WorkflowListEntry{entry},
		Width:   80,
		Config:  config.Config{Profiles: map[string]config.Profile{}, Transcripts: map[string]config.TranscriptExtractor{}},
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format,
				Inputs: []workflow.InputSpec{
					{Name: "mode", Type: "choice", Options: []string{"create", "delete"}},
					{Name: "branch", Type: "choice", Options: []string{"main"}, When: whenEq("inputs.mode", "create")},
					{Name: "target", Type: "choice", Options: []string{"gone"}, When: whenEq("inputs.mode", "delete")},
				},
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
	})
	m = apply(m, "enter", "enter") // mode=create, now on branch
	if m.session.Values()["mode"] != "create" || m.prompt == nil || m.prompt.Spec.Name != "branch" {
		t.Fatalf("prompt=%v values=%#v", promptSpecName(m), m.session.Values())
	}
	m = apply(m, "esc")           // back to mode before answering branch
	m = apply(m, "down", "enter") // mode=delete
	vals := m.session.Values()
	if vals["mode"] != "delete" {
		t.Fatalf("mode = %#v", vals)
	}
	if _, ok := vals["branch"]; ok {
		t.Fatalf("create-only branch retained: %#v", vals)
	}
	if m.prompt == nil || m.prompt.Spec.Name != "target" {
		t.Fatalf("expected delete-active target, prompt=%v", promptSpecName(m))
	}
}

func promptSpecName(m Model) string {
	if m.prompt == nil {
		return ""
	}
	return m.prompt.Spec.Name
}

func whenEq(path, value string) []workflow.WhenSpec {
	return []workflow.WhenSpec{{Kind: workflow.WhenEqual, Path: path, Value: value}}
}

func TestParityFailedRunEscapeReturnsToRunsRoot(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md "Failed run navigation"
	entry := workflow.WorkflowListEntry{Name: "plain", Source: "repo", File: "/r/plain.yaml", Title: "Plain"}
	var detached bool
	m := New(Options{
		Entries: []workflow.WorkflowListEntry{entry},
		Width:   80,
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format, Title: "Plain",
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
		LaunchRun: func(opts LaunchRunOpts) LaunchRunHandle {
			return LaunchRunHandle{Detach: func() { detached = true }}
		},
	})
	m = apply(m, "enter")
	if m.mode != modeRuns {
		t.Fatalf("launch must open Runs detail, mode=%v", m.mode)
	}
	id := m.runs.ActiveRunID()
	m = applyMsg(m, launchSettledMsg{OK: false, Detail: "spawn failed", RunID: id})
	body := m.View().Content
	if !strings.Contains(body, "LAUNCH FAILED") && !strings.Contains(body, "launch") {
		t.Fatalf("expected local launch failure detail:\n%s", body)
	}
	m = apply(m, "esc")
	if m.mode != modeRuns {
		t.Fatalf("Escape from failed launch must stay on Runs root, mode=%v", m.mode)
	}
	if m.runs.IsList() != true {
		t.Fatalf("Escape must return to Runs list, screen detail=%v", !m.runs.IsList())
	}
	if m.runs.SelectedID() != id {
		t.Fatalf("failed run must stay selected: got %q want %q", m.runs.SelectedID(), id)
	}
	_ = detached
}

func TestParityFormatInputPromptReportsOrdinal(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md "Input prompts state what they collect"
	got := FormatInputPrompt(workflow.InputSpec{Name: "unit", Type: "choice", Options: []string{"a", "b"}}, 1, 3)
	if !strings.Contains(got, "1 of 3") {
		t.Fatalf("missing collection ordinal in %q", got)
	}
	if !strings.Contains(got, "unit") || !strings.Contains(got, "pick one of 2") {
		t.Fatalf("prompt = %q", got)
	}
	base := FormatInputPrompt(workflow.InputSpec{Name: "unit", Type: "choice", Options: []string{"a", "b"}})
	if strings.Contains(base, "1 of") || strings.Contains(base, "2 of") {
		t.Fatalf("zero-arg FormatInputPrompt must omit ordinal: %q", base)
	}
}

func TestParityInputTitleRowKeepsSensitivityFlags(t *testing.T) {
	// Product Improvement: the title row keeps sensitivity names. The prompt line shows the ordinal.
	// openspec/specs/picker-presentation/spec.md "Title row keeps named sensitivity flags"
	entry := workflow.WorkflowListEntry{
		Name: "branchy", Source: "repo", File: "/r/b.yaml", Title: "Branch check", HasCommands: true,
	}
	m := New(Options{
		Entries: []workflow.WorkflowListEntry{entry},
		Width:   80,
		Config:  config.Config{Profiles: map[string]config.Profile{}, Transcripts: map[string]config.TranscriptExtractor{}},
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format, Title: "Branch check",
				Inputs: []workflow.InputSpec{
					{Name: "mode", Type: "choice", Options: []string{"a", "b"}},
					{Name: "unit", Type: "choice", Options: []string{"x", "y"}},
				},
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
	})
	m = apply(m, "enter")
	body := m.View().Content
	if !strings.Contains(body, "Branch check") || !strings.Contains(body, "commands") {
		t.Fatalf("title row must keep sensitivity flags:\n%s", body)
	}
	if strings.Contains(body, "input 1") || strings.Contains(body, "input 2") {
		t.Fatalf("title row must not replace flags with input N:\n%s", body)
	}
	if !strings.Contains(body, "1 of 2") {
		t.Fatalf("prompt line must carry collection ordinal:\n%s", body)
	}
}

func TestParityChoiceRowsUseASCIICursorAndLocation(t *testing.T) {
	// Product Improvement: ASCII ">" cursor and a location column on choice rows. No box or arrow glyphs.
	// openspec/specs/picker-presentation/spec.md "ASCII greater-than cursor on choice option rows"
	entry := workflow.WorkflowListEntry{Name: "branchy", Source: "repo", File: "/r/b.yaml", Title: "Branch check"}
	m := New(Options{
		Entries: []workflow.WorkflowListEntry{entry},
		Width:   80,
		Config:  config.Config{Profiles: map[string]config.Profile{}, Transcripts: map[string]config.TranscriptExtractor{}},
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format,
				Inputs: []workflow.InputSpec{
					{Name: "unit", Type: "choice", Options: []string{"alpha", "beta"}},
				},
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
	})
	m = apply(m, "enter")
	body := m.View().Content
	var selected, idle string
	for _, line := range strings.Split(body, "\n") {
		line = tui.StripContentPadding(line)
		if strings.HasPrefix(line, "/ ") {
			t.Fatalf("choice must not use OpenTUI slash prefix: %q", line)
		}
		for _, glyph := range []string{"▶", "▸", "►", "▌", "│", "┌", "└"} {
			if strings.Contains(line, glyph) {
				t.Fatalf("box/arrow glyph %q on choice row: %q", glyph, line)
			}
		}
		if strings.HasPrefix(line, "> ") && strings.Contains(line, "alpha") {
			selected = line
		}
		if strings.HasPrefix(line, "  ") && strings.Contains(line, "beta") {
			idle = line
		}
	}
	if selected == "" {
		t.Fatalf("missing ASCII > cursor on selected choice row:\n%s", body)
	}
	if idle == "" {
		t.Fatalf("idle choice row must use two-space prefix:\n%s", body)
	}
}

func TestParityCollectedAnswersVisibleDuringInput(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md collected answers scenarios
	entry := workflow.WorkflowListEntry{Name: "gated", Source: "repo", File: "/r/gated.yaml"}
	m := New(Options{
		Entries: []workflow.WorkflowListEntry{entry},
		Width:   80,
		Config:  config.Config{Profiles: map[string]config.Profile{}, Transcripts: map[string]config.TranscriptExtractor{}},
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format,
				Inputs: []workflow.InputSpec{
					{Name: "mode", Type: "choice", Options: []string{"create", "delete"}},
					{Name: "worktree", Type: "choice", Options: []string{"one"}, When: whenEq("inputs.mode", "delete")},
					{Name: "note", Type: "choice", Options: []string{"ok"}},
				},
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
	})
	m = apply(m, "enter")
	if strings.Contains(m.View().Content, "chosen:") {
		t.Fatal("first prompt must omit collected-answer line")
	}
	m = apply(m, "down", "enter") // mode=delete
	body := m.View().Content
	if !strings.Contains(body, "chosen: mode=delete") {
		t.Fatalf("guarded domain answers missing:\n%s", body)
	}
	m = apply(m, "enter") // worktree=one, now on note
	if !strings.Contains(m.View().Content, "worktree=one") {
		t.Fatalf("worktree answer missing:\n%s", m.View().Content)
	}
	m = apply(m, "esc") // back to worktree; note discarded (never answered)
	m = apply(m, "esc") // back to mode; worktree discarded
	vals := m.session.Values()
	if _, ok := vals["worktree"]; ok {
		t.Fatalf("worktree retained after back: %#v", vals)
	}
	if vals["mode"] != "delete" {
		t.Fatalf("mode not restored: %#v", vals)
	}
	if strings.Contains(m.View().Content, "worktree=") {
		t.Fatalf("discarded later answer still listed:\n%s", m.View().Content)
	}
}

func TestParityEmptyCatalogFooterAndMessage(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md empty catalog scenarios
	m := New(Options{Entries: nil, Width: 80})
	body := m.View().Content
	if !strings.Contains(body, "no runnable workflows") {
		t.Fatalf("empty message:\n%s", body)
	}
	if strings.Contains(body, tui.FilterWorkflows) {
		t.Fatal("filter must be hidden")
	}
	if !strings.Contains(body, "tab runs") || !strings.Contains(body, "ctrl+k") || !strings.Contains(body, "esc") {
		t.Fatalf("empty footer:\n%s", body)
	}
	if strings.Contains(body, "enter run") {
		t.Fatal("empty footer must not claim run")
	}
}

func TestParityTabFromFilterDoesNotInsertTab(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md "Workflow filter has text"
	m := New(Options{Entries: catalogEntries(), Width: 80, RepoRoot: t.TempDir()})
	m = apply(m, "d", "e", "p")
	if m.filter != "dep" {
		t.Fatalf("filter = %q", m.filter)
	}
	m = apply(m, "tab")
	if m.mode != modeRuns {
		t.Fatalf("mode = %v", m.mode)
	}
	if strings.Contains(m.filter, "\t") {
		t.Fatal("tab must not enter workflow filter")
	}
}

func TestParityCursorMovesChangesDetailOnly(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md "Cursor moves"
	m := New(Options{Entries: eightEntries()[:3], Width: 80})
	first := m.View().Content
	m = apply(m, "down")
	second := m.View().Content
	if first == second {
		t.Fatal("detail must change with cursor")
	}
	if listRowCount(first) != listRowCount(second) {
		t.Fatal("row count must stay fixed")
	}
}

func TestParityConsentUsesWarnWithoutDim(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md "Warnings are not the least legible element"
	entry := workflow.WorkflowListEntry{
		Name: "deploy", Source: "global", File: "/g/deploy.yaml", Title: "Deploy", HasCommands: true,
	}
	m := New(Options{
		Entries: []workflow.WorkflowListEntry{entry},
		Width:   80,
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format,
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
	})
	m = apply(m, "enter")
	line := m.consentLine()
	if line == "" || !strings.Contains(line, "commands") {
		t.Fatalf("consent line = %q", line)
	}
	theme := tui.DefaultTheme()
	if theme.Warn.GetFaint() {
		t.Fatal("warn style must not be dim/faint")
	}
}

func TestParityLaunchOpensStartingRunningLifecycle(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md "A launched workflow opens matching run detail"
	entry := workflow.WorkflowListEntry{Name: "plain", Source: "repo", File: "/r/plain.yaml", Title: "Plain"}
	var (
		launched LaunchRunOpts
		detached bool
	)
	m := New(Options{
		Entries:  []workflow.WorkflowListEntry{entry},
		Width:    80,
		RepoRoot: t.TempDir(),
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format, Title: "Plain",
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
		LaunchRun: func(opts LaunchRunOpts) LaunchRunHandle {
			launched = opts
			return LaunchRunHandle{Detach: func() { detached = true }}
		},
		AllocateRunID: func() string {
			return "550e8400-e29b-41d4-a716-446655440000"
		},
	})
	m = apply(m, "enter")
	if m.mode != modeRuns {
		t.Fatalf("mode = %v, want modeRuns", m.mode)
	}
	body := m.View().Content
	if !strings.Contains(body, "STARTING") {
		t.Fatalf("expected STARTING detail:\n%s", body)
	}
	if launched.RunID != "550e8400-e29b-41d4-a716-446655440000" {
		t.Fatalf("launch RunID = %q", launched.RunID)
	}
	if launched.Name != "plain" {
		t.Fatalf("launch Name = %q", launched.Name)
	}

	m = applyMsg(m, launchAckMsg{Line: "@hwf-history:claimed 550e8400-e29b-41d4-a716-446655440000"})
	body = m.View().Content
	if !strings.Contains(body, "RUNNING") {
		t.Fatalf("claim must move detail to RUNNING:\n%s", body)
	}

	m2 := New(Options{
		Entries: []workflow.WorkflowListEntry{entry},
		Width:   80,
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format, Title: "Plain",
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
		LaunchRun: func(opts LaunchRunOpts) LaunchRunHandle {
			return LaunchRunHandle{Detach: func() {}}
		},
		AllocateRunID: func() string { return "550e8400-e29b-41d4-a716-446655440001" },
	})
	m2 = apply(m2, "enter")
	m2 = applyMsg(m2, launchAckMsg{Line: "@hwf-history:unavailable 550e8400-e29b-41d4-a716-446655440001"})
	if !strings.Contains(m2.View().Content, "HISTORY UNAVAILABLE") {
		t.Fatalf("history unavailable:\n%s", m2.View().Content)
	}

	m3 := New(Options{
		Entries: []workflow.WorkflowListEntry{entry},
		Width:   80,
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format, Title: "Plain",
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
		LaunchRun: func(opts LaunchRunOpts) LaunchRunHandle {
			return LaunchRunHandle{Detach: func() { detached = true }}
		},
		AllocateRunID: func() string { return "550e8400-e29b-41d4-a716-446655440002" },
	})
	m3 = apply(m3, "enter")
	m3 = applyMsg(m3, launchSettledMsg{OK: false, Detail: "child exited", RunID: "550e8400-e29b-41d4-a716-446655440002"})
	if !strings.Contains(m3.View().Content, "LAUNCH FAILED") {
		t.Fatalf("child fail before claim:\n%s", m3.View().Content)
	}

	stateDir := t.TempDir()
	checkout := t.TempDir()
	getenv := func(key string) string {
		if key == "HERDR_PLUGIN_STATE_DIR" {
			return stateDir
		}
		return os.Getenv(key)
	}
	successID := "550e8400-e29b-41d4-a716-446655440003"
	startedAt := time.Now().UTC().Add(-5 * time.Second).Format("2006-01-02T15:04:05.000Z")
	w := history.NewWriter(getenv)
	t.Cleanup(w.Dispose)
	claimed := w.Claim(history.ClaimMeta{
		ID: successID, Workflow: "plain", Title: "Plain", Source: "repo",
		CheckoutRoot: checkout, StartedAt: startedAt,
	})
	if !claimed.OK || claimed.State != "claimed" {
		t.Fatalf("success claim = %+v", claimed)
	}
	w.RecordStep(history.StepRecord{
		StepIdentity: history.StepIdentity{
			Phase: "main", Workflow: "plain", WorkflowPath: []string{"plain"},
			Ordinal: 1, Total: 1, Action: "run", Label: "echo-ok",
		},
		FinishedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Outcome:    "succeeded",
	})
	w.Finalize("succeeded", history.FinalizeOpts{})

	m4 := New(Options{
		Entries:  []workflow.WorkflowListEntry{entry},
		Width:    80,
		RepoRoot: checkout,
		Env:      getenv,
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format, Title: "Plain",
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
		LaunchRun: func(opts LaunchRunOpts) LaunchRunHandle {
			return LaunchRunHandle{Detach: func() { detached = true }}
		},
		AllocateRunID: func() string { return successID },
	})
	m4 = apply(m4, "enter")
	m4 = applyMsg(m4, launchAckMsg{Line: "@hwf-history:claimed " + successID})
	m4 = applyMsg(m4, launchSettledMsg{OK: true, Detail: "", RunID: successID})
	if m4.quit || m4.mode != modeRuns {
		t.Fatalf("fast success must stay open on Runs detail, mode=%v quit=%v", m4.mode, m4.quit)
	}
	presented := history.RunDetail(successID, getenv, time.Time{})
	if presented.Detail.ElapsedMs <= 0 {
		t.Fatalf("expected elapsed > 0, got %d", presented.Detail.ElapsedMs)
	}
	elapsed := history.FormatElapsed(presented.Detail.ElapsedMs)
	body = m4.View().Content
	if !strings.Contains(body, "SUCCEEDED") {
		t.Fatalf("fast success detail must show SUCCEEDED:\n%s", body)
	}
	if !strings.Contains(body, "echo-ok") || !strings.Contains(body, "succeeded") {
		t.Fatalf("fast success detail must show recorded step outcomes:\n%s", body)
	}
	if !strings.Contains(body, elapsed) {
		t.Fatalf("fast success detail must show elapsed %q:\n%s", elapsed, body)
	}

	failID := "550e8400-e29b-41d4-a716-446655440005"
	failStarted := time.Now().UTC().Add(-3 * time.Second).Format("2006-01-02T15:04:05.000Z")
	fw := history.NewWriter(getenv)
	t.Cleanup(fw.Dispose)
	failClaimed := fw.Claim(history.ClaimMeta{
		ID: failID, Workflow: "plain", Title: "Plain", Source: "repo",
		CheckoutRoot: checkout, StartedAt: failStarted,
	})
	if !failClaimed.OK || failClaimed.State != "claimed" {
		t.Fatalf("fail claim = %+v", failClaimed)
	}
	fw.RecordStep(history.StepRecord{
		StepIdentity: history.StepIdentity{
			Phase: "main", Workflow: "plain", WorkflowPath: []string{"plain"},
			Ordinal: 1, Total: 1, Action: "run", Label: "boom-step",
		},
		FinishedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Outcome:    "failed",
	})
	fw.Finalize("failed", history.FinalizeOpts{})

	mFail := New(Options{
		Entries:  []workflow.WorkflowListEntry{entry},
		Width:    80,
		RepoRoot: checkout,
		Env:      getenv,
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format, Title: "Plain",
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
		LaunchRun: func(opts LaunchRunOpts) LaunchRunHandle {
			return LaunchRunHandle{Detach: func() { detached = true }}
		},
		AllocateRunID: func() string { return failID },
	})
	mFail = apply(mFail, "enter")
	mFail = applyMsg(mFail, launchAckMsg{Line: "@hwf-history:claimed " + failID})
	mFail = applyMsg(mFail, launchSettledMsg{OK: false, Detail: "child exited", RunID: failID})
	failBody := mFail.View().Content
	if strings.Contains(failBody, "RUNNING") {
		t.Fatalf("claim-then-fail must not leave synthetic RUNNING:\n%s", failBody)
	}
	if strings.Contains(failBody, "LAUNCH FAILED") {
		t.Fatalf("claim-then-fail must use persisted detail, not local-failure:\n%s", failBody)
	}
	if !strings.Contains(failBody, "FAILED") && !strings.Contains(failBody, "INTERRUPTED") {
		t.Fatalf("claim-then-fail must show FAILED or INTERRUPTED persisted detail:\n%s", failBody)
	}
	if !strings.Contains(failBody, "boom-step") {
		t.Fatalf("claim-then-fail must show recorded step outcomes:\n%s", failBody)
	}

	detached = false
	m5 := New(Options{
		Entries: []workflow.WorkflowListEntry{entry},
		Width:   80,
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format, Title: "Plain",
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
		LaunchRun: func(opts LaunchRunOpts) LaunchRunHandle {
			return LaunchRunHandle{Detach: func() { detached = true }}
		},
		AllocateRunID: func() string { return "550e8400-e29b-41d4-a716-446655440004" },
	})
	m5 = apply(m5, "enter")
	m5 = apply(m5, "esc")
	if !detached {
		t.Fatal("Escape from active launch must detach child observation")
	}
	if m5.mode != modeRuns {
		t.Fatalf("Escape must return to Runs root, mode=%v", m5.mode)
	}
	if !m5.runs.IsList() {
		t.Fatalf("Escape must land on Runs list")
	}
}

func TestParityPrintableKFilters(t *testing.T) {
	// openspec/specs/picker-editor-actions/spec.md "Printable k filters"
	m := New(Options{Entries: catalogEntries(), Width: 80})
	m = apply(m, "k")
	if m.filter != "k" || m.mode != modeList {
		t.Fatalf("filter=%q mode=%v", m.filter, m.mode)
	}
}

func TestParityPaletteLettersHandoff(t *testing.T) {
	// openspec/specs/picker-editor-actions/spec.md n/i/e/o/s actions
	root := t.TempDir()
	deployPath := root + "/deploy.yaml"
	if err := os.WriteFile(deployPath, []byte("version: v1alpha1\nsteps:\n  - run: [echo, hi]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	entries := []workflow.WorkflowListEntry{
		{Name: "build", Source: "repo", File: root + "/build.yaml", Title: "Build"},
		{Name: "deploy", Source: "repo", File: deployPath, Title: "Deploy"},
	}
	var (
		edited   []string
		opened   []string
		copied   string
		notified []string
	)
	edit := func(path, name string) workflow.ValidateResult {
		edited = append(edited, name+"@"+path)
		return workflow.ValidateResult{OK: true}
	}
	m := New(Options{
		Entries:       entries,
		Width:         80,
		RepoRoot:      root,
		EditWorkflow:  edit,
		OpenURL:       func(url string) error { opened = append(opened, url); return nil },
		CopyClipboard: func(text string) error { copied = text; return nil },
		Notify: func(title string, body ...string) error {
			notified = append(notified, title+"|"+strings.Join(body, " "))
			return nil
		},
		ExportShare: func(entry workflow.WorkflowListEntry) (string, error) {
			return `hwf workflow import "bundle-` + entry.Name + `"`, nil
		},
	})
	m = apply(m, "ctrl+k", "n")
	if m.quit || m.mode != modeNewName {
		t.Fatalf("new must prompt for name, quit=%v mode=%v", m.quit, m.mode)
	}
	m = apply(m, "s", "h", "i", "p", "enter")
	if m.quit || m.mode != modeList {
		t.Fatalf("new after create quit=%v mode=%v", m.quit, m.mode)
	}
	if len(edited) == 0 || !strings.Contains(edited[0], "ship@") {
		t.Fatalf("new edit = %v", edited)
	}
	if !strings.Contains(m.status, "validated ship") {
		t.Fatalf("new status = %q", m.status)
	}
	if _, err := os.Stat(root + "/.hwf/workflows/ship.yaml"); err != nil {
		t.Fatalf("stub missing: %v", err)
	}

	m = New(Options{Entries: entries, Width: 80, RepoRoot: root})
	m = apply(m, "ctrl+k", "i")
	if m.quit || m.mode != modeList {
		t.Fatalf("import quit=%v mode=%v", m.quit, m.mode)
	}
	if !strings.Contains(m.status, "hwf workflow import") {
		t.Fatalf("import status = %q", m.status)
	}

	m = New(Options{
		Entries: entries,
		Width:   80,
		OpenURL: func(url string) error { opened = append(opened, url); return nil },
	})
	opened = nil
	m = apply(m, "ctrl+k", "e")
	if m.quit {
		t.Fatal("examples must keep picker open")
	}
	if m.mode != modeList {
		t.Fatalf("examples mode=%v", m.mode)
	}
	if len(opened) == 0 || opened[0] != config.ExamplesURL {
		t.Fatalf("examples url = %v", opened)
	}

	edited = nil
	m = New(Options{
		Entries:      entries,
		Width:        80,
		RepoRoot:     root,
		EditWorkflow: edit,
	})
	m = apply(m, "down", "ctrl+k", "o")
	if m.quit || m.mode != modeList {
		t.Fatalf("open must stay on list, quit=%v mode=%v", m.quit, m.mode)
	}
	if len(edited) != 1 || !strings.HasPrefix(edited[0], "deploy@") {
		t.Fatalf("open edit = %v", edited)
	}
	if !strings.Contains(m.status, "validated deploy") {
		t.Fatalf("open status = %q", m.status)
	}

	m = New(Options{
		Entries:       entries,
		Width:         80,
		CopyClipboard: func(text string) error { copied = text; return nil },
		Notify: func(title string, body ...string) error {
			notified = append(notified, strings.Join(append([]string{title}, body...), "|"))
			return nil
		},
		ExportShare: func(entry workflow.WorkflowListEntry) (string, error) {
			return `hwf workflow import "bundle-` + entry.Name + `"`, nil
		},
	})
	copied, notified = "", nil
	m = apply(m, "down", "ctrl+k", "s")
	if m.quit || m.mode != modeList {
		t.Fatalf("share must stay on list, quit=%v mode=%v", m.quit, m.mode)
	}
	if !strings.Contains(copied, "hwf workflow import") {
		t.Fatalf("clipboard = %q", copied)
	}
	joined := strings.Join(notified, " ")
	if !strings.Contains(joined, "deploy") || !strings.Contains(strings.ToLower(joined), "clipboard") {
		t.Fatalf("notify = %v", notified)
	}
	entry := entries[1]
	if ResolvePaletteLetter("s", &entry) == nil || ResolvePaletteLetter("s", &entry).Entry == nil {
		t.Fatal("share must keep the selected entry")
	}
}

func TestParityCancelDeleteKeepsFile(t *testing.T) {
	// openspec/specs/picker-editor-actions/spec.md "Cancel delete"
	dir := t.TempDir()
	path := dir + "/deploy.yaml"
	if err := os.WriteFile(path, []byte("name: deploy\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	entry := workflow.WorkflowListEntry{Name: "deploy", Source: "repo", File: path, Title: "Deploy"}
	m := New(Options{Entries: []workflow.WorkflowListEntry{entry}, Width: 80})
	m = apply(m, "ctrl+k", "d", "n")
	if m.mode != modeList {
		t.Fatalf("mode = %v", m.mode)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("file removed on cancel: %v", err)
	}
}
