package picker

import (
	"os"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

// Spec scenarios owned by picker.ParityBaseline (picker-presentation + picker-workbench-actions).
// openspec/specs/picker-presentation/spec.md
// openspec/specs/picker-workbench-actions/spec.md
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
	"Correct the final answer",
	"Mode change alters active inputs",
	"Failed run navigation",
	"Dropdown of many options",
	"Undescribed input",
	"Custom value accepted",
	"Constrained text input",
	"Unresolved dynamic domain",
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
	"Existing workbench",
	"Stale endpoint",
	"Different repository",
	"Endpoint record written",
	"Environment-controlled state directory is checked",
	"Lock file carries the same protection",
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
	"Share does not open workbench",
	"Confirmed delete",
	"Cancel delete",
}

func TestParityBaselineCoversSpecScenarios(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md
	// openspec/specs/picker-workbench-actions/spec.md
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
		if line == "" {
			blank++
		}
	}
	if listRowCount(body) != 2 {
		t.Fatalf("visible named rows = %d, want 2\n%s", listRowCount(body), body)
	}
	if blank < 4 {
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

func TestParityFailedRunEscapeReturnsToListNotRuns(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md "Failed run navigation"
	// Gap: Escape from modeFail/modeRun returns to modeList, not Runs root.
	entry := workflow.WorkflowListEntry{Name: "plain", Source: "repo", File: "/r/plain.yaml"}
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
	if m.mode != modeRun {
		t.Fatalf("mode = %v", m.mode)
	}
	m = apply(m, "esc")
	if m.mode != modeList {
		t.Fatalf("actual Go: Escape returns mode=%v, want modeList (Gap vs Runs root)", m.mode)
	}
	if m.mode == modeRuns {
		t.Fatal("unexpected Runs root — clear Gap when product matches spec")
	}
}

func TestParityFormatInputPromptOmitsOrdinal(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md input prompt ordinal
	// Gap: FormatInputPrompt does not render collection ordinal (1 of N).
	got := FormatInputPrompt(workflow.InputSpec{Name: "unit", Type: "choice", Options: []string{"a", "b"}})
	if strings.Contains(got, "1 of") || strings.Contains(got, "1/") || strings.Contains(got, "position") {
		t.Fatalf("unexpected ordinal in %q — clear Gap when added", got)
	}
	if !strings.Contains(got, "unit") || !strings.Contains(got, "pick one of 2") {
		t.Fatalf("prompt = %q", got)
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

func TestParityLaunchModeRunWithoutClaimLifecycle(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md launch STARTING/RUNNING/history/claim scenarios
	// Gap: acceptCurrent enters modeRun with name/consent only; no UUID claim or STARTING label.
	entry := workflow.WorkflowListEntry{Name: "plain", Source: "repo", File: "/r/plain.yaml", Title: "Plain"}
	m := New(Options{
		Entries: []workflow.WorkflowListEntry{entry},
		Width:   80,
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format, Title: "Plain",
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
	})
	m = apply(m, "enter")
	if m.mode != modeRun {
		t.Fatalf("mode = %v", m.mode)
	}
	body := m.View().Content
	for _, label := range []string{"STARTING", "RUNNING", "HISTORY UNAVAILABLE", "launch failure"} {
		if strings.Contains(body, label) {
			t.Fatalf("unexpected launch label %q — clear Gap when launch lands:\n%s", label, body)
		}
	}
	m = apply(m, "esc")
	if m.quit {
		t.Fatal("actual Go: Escape from modeRun clears to list without quit (see handleKey order)")
	}
	if m.mode != modeList {
		t.Fatalf("leave launch mode=%v", m.mode)
	}
}

func TestParityPrintableKFilters(t *testing.T) {
	// openspec/specs/picker-workbench-actions/spec.md "Printable k filters"
	m := New(Options{Entries: catalogEntries(), Width: 80})
	m = apply(m, "k")
	if m.filter != "k" || m.mode != modeList {
		t.Fatalf("filter=%q mode=%v", m.filter, m.mode)
	}
}

func TestParityPaletteLettersResolveWithoutHandoff(t *testing.T) {
	// openspec/specs/picker-workbench-actions/spec.md n/i/e/o/s actions
	// Gap: handlePalette resolves letters then returns to list; no workbench/clipboard/browser call.
	m := New(Options{Entries: catalogEntries(), Width: 80})
	m = apply(m, "ctrl+k", "n")
	if m.mode != modeList {
		t.Fatalf("after n mode=%v", m.mode)
	}
	if m.quit {
		t.Fatal("Gap: picker must stay open today; clear when dismiss-on-handoff lands")
	}
	m = apply(m, "ctrl+k", "e")
	if m.mode != modeList {
		t.Fatalf("after e mode=%v", m.mode)
	}
	entry := catalogEntries()[1]
	if ResolvePaletteLetter("s", &entry) == nil || ResolvePaletteLetter("s", &entry).Route != "" {
		t.Fatal("share must not open a workbench route")
	}
	if ResolvePaletteLetter("o", &entry).Route != "w=global:deploy" && ResolvePaletteLetter("o", &entry).Route != "w=repo:deploy" {
		got := ResolvePaletteLetter("o", &entry)
		if got == nil || !strings.HasPrefix(got.Route, "w=") {
			t.Fatalf("open route = %+v", got)
		}
	}
}

func TestParityCancelDeleteKeepsFile(t *testing.T) {
	// openspec/specs/picker-workbench-actions/spec.md "Cancel delete"
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
