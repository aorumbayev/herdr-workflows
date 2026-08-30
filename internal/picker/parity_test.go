package picker

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

var testFuncDecl = regexp.MustCompile(`(?m)^func (Test\w+)\(`)

func loadPackageTestFuncs(dirs ...string) map[string]struct{} {
	out := make(map[string]struct{})
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), "_test.go") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				continue
			}
			for _, m := range testFuncDecl.FindAllSubmatch(data, -1) {
				out[string(m[1])] = struct{}{}
			}
		}
	}
	return out
}

func coveringTestExists(name string, own map[string]struct{}, external map[string]map[string]struct{}) bool {
	if pkg, fn, ok := strings.Cut(name, "."); ok {
		funcs, found := external[pkg]
		if !found {
			return false
		}
		_, ok := funcs[fn]
		return ok
	}
	_, ok := own[name]
	return ok
}

// Spec scenarios that picker.ParityBaseline owns (picker-presentation + picker-editor-actions).
var requiredPickerParityScenarios = []string{
	"Title appears only in the pane label",
	"No runtime retitling",
	"More workflows than the viewport",
	"Cursor moves beyond the viewport",
	"Fewer matches than the viewport",
	"Tall popup shows more rows",
	"Pointer hit rows follow the viewport",
	"Status row is reserved",
	"Sensitive workflow",
	"Unbounded flag list does not widen the row",
	"Overlong title",
	"Inputs are not advertised in the row",
	"Flags shown before run",
	"Sensitivity is compact during input and prominent at launch",
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
	"Question renders above the options",
	"Progress type answers and back share one muted line",
	"Sensitivity line appears only when sensitive",
	"Dropdown of many options",
	"Undescribed input",
	"Custom value accepted",
	"Constrained text input",
	"Unresolved dynamic domain",
	"Long description wraps instead of truncating",
	"Text prompt demotes hints to the stats line",
	"Choice prompt fits the compact popup",
	"Choice input filter row shows typed text",
	"Compact sensitivity note during input",
	"A guarded domain is explained by an earlier answer",
	"First prompt has no answers",
	"Answers exceed the popup width",
	"Backward navigation drops later answers",
	"Hotkey with no workflows",
	"Empty footer",
	"No matches for filter",
	"Workflow filter has text",
	"Input collection",
	"Cycle past runs",
	"Cycle to profiles",
	"Return to workflows",
	"Tab bar shows the active browser",
	"Tab bar centers in the popup",
	"Shift+Tab cycles backward",
	"Tab never quits the overlay",
	"Profiles listed with source column",
	"Profiles filter by typed text",
	"Empty profiles guide to the palette",
	"Manifest uses percent size",
	"Confirmed pop-out quits the picker",
	"Canceled pop-out keeps the workflow filter",
	"Palette is the only route to the console",
	"Failed pop-out stays in the overlay",
	"Hover differs from the cursor",
	"Wheel has a keyboard twin",
	"Pointer tab select obeys the keyboard guard",
	"Pointer select on the active tab changes nothing",
	"Reverse wins on the hovered cursor row",
	"Invalid location uses warn",
	"Sensitivity marker uses warn",
	"Runs status uses indexed slots",
	"Content keeps the terminal foreground",
	"Child acknowledges start",
	"Child cannot record history",
	"History refuses the claim",
	"Child fails before claim",
	"Leave an active launch",
	"Newer release appears after mount",
	"Update service is unavailable",
	"Draft is not advertised",
	"Open palette",
	"Printable k filters",
	"Escape closes palette",
	"Palette uses the shared chrome",
	"Manifest uses the compact size",
	"Same-size switch stays in place",
	"Restored picker does not respawn",
	"Run detail expands the popup",
	"Leave run detail respawns compact",
	"New from empty catalog",
	"Import from empty catalog",
	"Browse examples",
	"New offers agent or template",
	"New agent handoff types the create prompt",
	"New agent with no panes stays in the overlay",
	"Agent chooser names each pane",
	"New template chooses repo or global",
	"New template popup opens expanded",
	"Open repo workflow in the popup",
	"Open in a new tab",
	"Open without selection",
	"Empty catalog palette",
	"Selected workflow palette",
	"Open uses ExecProcess",
	"Missing editor is a hard error",
	"Share copies command",
	"Share stays in picker",
	"Confirmed delete",
	"Cancel delete",
	"New profile writes a skeleton to the chosen layer",
	"New profile rejects a duplicate name",
	"Open profile edits the defining config file",
	"Profile edit validates the config loader",
	"New profile popup opens expanded",
}

func TestParityBaselineCoversSpecScenarios(t *testing.T) {
	ownTests := loadPackageTestFuncs(".")
	externalTests := map[string]map[string]struct{}{
		"tui":      loadPackageTestFuncs("../tui"),
		"contract": loadPackageTestFuncs("../../scripts/contract"),
	}
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
		} else if !coveringTestExists(row.CoveringTest, ownTests, externalTests) {
			t.Errorf("scenario %q CoveringTest %q does not exist", row.Scenario, row.CoveringTest)
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
	m := New(Options{Entries: eightEntries(), Width: 80})
	m = apply(m, "b", "r", "a", "v", "o")
	body := m.View().Content
	if !strings.HasSuffix(strings.TrimSpace(strings.Split(body, "\n")[len(strings.Split(body, "\n"))-1]), "1/1") &&
		!strings.Contains(body, "1/1") {
		t.Fatalf("counter missing 1/1:\n%s", body)
	}
}

func TestParityNoScrollThumbGlyph(t *testing.T) {
	m := New(Options{Entries: eightEntries(), Width: 62})
	body := m.View().Content
	for _, glyph := range []string{"▐", "█", "▓", "░", "▲", "▼", "┃"} {
		if strings.Contains(body, glyph) {
			t.Fatalf("scroll thumb glyph %q present:\n%s", glyph, body)
		}
	}
}

func TestParityListFooterIdentifiesRunCtrlPDismiss(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80})
	body := m.View().Content
	if !strings.Contains(body, "enter run") || !strings.Contains(body, "ctrl+p") || !strings.Contains(body, "esc") {
		t.Fatalf("footer hints:\n%s", body)
	}
}

func TestParityWidthChangeRecomputesTruncation(t *testing.T) {
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
	entry := workflow.ListEntry{Name: "gated", Source: "repo", File: "/r/gated.yaml"}
	m := New(Options{
		Entries: []workflow.ListEntry{entry},
		Width:   80,
		Config:  config.Config{Profiles: map[string]config.Profile{}, Transcripts: map[string]config.TranscriptExtractor{}},
		LoadWorkflow: func(e workflow.ListEntry) (*workflow.Definition, error) {
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
	entry := workflow.ListEntry{Name: "plain", Source: "repo", File: "/r/plain.yaml", Title: "Plain"}
	var detached bool
	m := New(Options{
		Entries: []workflow.ListEntry{entry},
		Width:   80,
		LoadWorkflow: func(e workflow.ListEntry) (*workflow.Definition, error) {
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
	m = applyMsg(m, launchAckMsg{Line: "@hwf-history:rejected " + id + " spawn failed"})
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
	spec := workflow.InputSpec{Name: "unit", Type: "choice", Options: []string{"a", "b"}}
	field := FormatInputPrompt(spec, 60)
	if field != "unit" {
		t.Fatalf("field line must be the name alone, no ordinal: %q", field)
	}
	hints := FormatInputHints(spec)
	if hints != "pick one of 2" {
		t.Fatalf("hints = %q", hints)
	}
	stats := FormatInputStats(80, 1, 3, hints, "", tui.BackHint)
	if !strings.HasPrefix(stats, "1/3") {
		t.Fatalf("stats line must lead with the collection ordinal: %q", stats)
	}
	if !strings.Contains(stats, "pick one of 2") || !strings.Contains(stats, tui.BackHint) {
		t.Fatalf("stats line must carry the type and back hint: %q", stats)
	}
}

func TestParityInputTitleRowKeepsSensitivityFlags(t *testing.T) {
	// Product Improvement: the title row keeps sensitivity names. The prompt line shows the ordinal.
	entry := workflow.ListEntry{
		Name: "branchy", Source: "repo", File: "/r/b.yaml", Title: "Branch check", HasCommands: true,
	}
	m := New(Options{
		Entries: []workflow.ListEntry{entry},
		Width:   80,
		Config:  config.Config{Profiles: map[string]config.Profile{}, Transcripts: map[string]config.TranscriptExtractor{}},
		LoadWorkflow: func(e workflow.ListEntry) (*workflow.Definition, error) {
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
	if !strings.Contains(body, tui.TouchesPrefix) || !strings.Contains(body, "commands") {
		t.Fatalf("input must show the compact sensitivity note:\n%s", body)
	}
	if strings.Contains(body, "1 of 2") {
		t.Fatalf("prompt line must not carry the old ordinal form:\n%s", body)
	}
	if !strings.Contains(body, "1/2") {
		t.Fatalf("stats line must carry the collection ordinal:\n%s", body)
	}
	// The final pre-run consent still names the flags prominently.
	if m.consent != "Branch check"+tui.ChromeSep+"repo"+tui.ChromeSep+"commands" {
		t.Fatalf("final consent must keep the named flags: %q", m.consent)
	}
}

func TestParityChoiceRowsUseASCIICursor(t *testing.T) {
	// Product Improvement: ASCII ">" cursor and a location column on choice rows. No box or arrow glyphs.
	entry := workflow.ListEntry{Name: "branchy", Source: "repo", File: "/r/b.yaml", Title: "Branch check"}
	m := New(Options{
		Entries: []workflow.ListEntry{entry},
		Width:   80,
		Config:  config.Config{Profiles: map[string]config.Profile{}, Transcripts: map[string]config.TranscriptExtractor{}},
		LoadWorkflow: func(e workflow.ListEntry) (*workflow.Definition, error) {
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
	entry := workflow.ListEntry{Name: "gated", Source: "repo", File: "/r/gated.yaml"}
	m := New(Options{
		Entries: []workflow.ListEntry{entry},
		Width:   80,
		Config:  config.Config{Profiles: map[string]config.Profile{}, Transcripts: map[string]config.TranscriptExtractor{}},
		LoadWorkflow: func(e workflow.ListEntry) (*workflow.Definition, error) {
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
	m := New(Options{Entries: nil, Width: 80})
	body := m.View().Content
	if !strings.Contains(body, "no runnable workflows") {
		t.Fatalf("empty message:\n%s", body)
	}
	if strings.Contains(body, tui.FilterWorkflows) {
		t.Fatal("filter must be hidden")
	}
	if !strings.Contains(body, "ctrl+p") || !strings.Contains(body, "esc") {
		t.Fatalf("empty footer:\n%s", body)
	}
	if strings.Contains(body, "enter run") {
		t.Fatal("empty footer must not claim run")
	}
}

func TestParityTabFromFilterDoesNotInsertTab(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80, RepoRoot: t.TempDir()})
	m = apply(m, "l", "o", "y")
	if m.filter != "loy" {
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

func TestParityConsentDemotedDuringInputProminentAtLaunch(t *testing.T) {
	entry := workflow.ListEntry{
		Name: "deploy", Source: "global", File: "/g/deploy.yaml", Title: "Deploy", HasCommands: true,
	}
	m := New(Options{
		Entries: []workflow.ListEntry{entry},
		Width:   80,
		Config:  config.Config{Profiles: map[string]config.Profile{}, Transcripts: map[string]config.TranscriptExtractor{}},
		LoadWorkflow: func(e workflow.ListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format,
				Inputs: []workflow.InputSpec{{Name: "unit", Type: "choice", Options: []string{"a", "b"}}},
				Steps:  []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
	})
	m = apply(m, "enter")
	w := m.contentWidth()
	line := m.sensitivityLine(w)
	if line != tui.MuteChrome(tui.Truncate(tui.TouchesPrefix+"commands", w)) {
		t.Fatalf("mid-input sensitivity must be the compact muted note: %q", line)
	}
	if m.consent != "Deploy"+tui.ChromeSep+"global"+tui.ChromeSep+"commands" {
		t.Fatalf("final consent must name the flags: %q", m.consent)
	}
}

func launchModel(t *testing.T, runID string, detached *bool) Model {
	t.Helper()
	entry := workflow.ListEntry{Name: "plain", Source: "repo", File: "/r/plain.yaml", Title: "Plain"}
	return New(Options{
		Entries:  []workflow.ListEntry{entry},
		Width:    80,
		RepoRoot: t.TempDir(),
		LoadWorkflow: func(e workflow.ListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format, Title: "Plain",
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
		LaunchRun: func(opts LaunchRunOpts) LaunchRunHandle {
			return LaunchRunHandle{Detach: func() { *detached = true }}
		},
		AllocateRunID: func() string { return runID },
	})
}

func TestParityLaunchFailureBeforeClaimShowsTheReason(t *testing.T) {
	failID := "550e8400-e29b-41d4-a716-446655440006"
	events := make(chan LaunchEvent, 1)
	entry := workflow.ListEntry{Name: "plain", Source: "repo", File: "/r/plain.yaml", Title: "Plain"}
	m := New(Options{
		Entries:  []workflow.ListEntry{entry},
		Width:    80,
		RepoRoot: t.TempDir(),
		LoadWorkflow: func(e workflow.ListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format, Title: "Plain",
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
		LaunchRun: func(LaunchRunOpts) LaunchRunHandle {
			return LaunchRunHandle{Detach: func() {}, Events: events}
		},
		AllocateRunID: func() string { return failID },
	})
	next, cmd := m.Update(press("enter"))
	m = next.(Model)
	if cmd == nil {
		t.Fatal("a launch must listen for events")
	}
	events <- LaunchEvent{Fail: "exec format error"}
	next, _ = m.Update(cmd())
	m = next.(Model)
	if m.quit {
		t.Fatal("a child that never claimed must keep the popup open")
	}
	body := m.View().Content
	if !strings.Contains(body, "LAUNCH FAILED") {
		t.Fatalf("a child that never claimed must show the failure:\n%s", body)
	}
	if !strings.Contains(body, "exec format error") {
		t.Fatalf("a child that never claimed must show the reason text:\n%s", body)
	}

	var detached bool
	unavailableID := "550e8400-e29b-41d4-a716-446655440007"
	m2 := apply(launchModel(t, unavailableID, &detached), "enter")
	m2 = applyMsg(m2, launchAckMsg{Line: "@hwf-history:unavailable " + unavailableID})
	m2 = applyMsg(m2, launchFailedMsg{Detail: "run exited 1"})
	if strings.Contains(m2.View().Content, "LAUNCH FAILED") {
		t.Fatalf("a failure after an ack must not overwrite the ack surface:\n%s", m2.View().Content)
	}
}

func TestParityLaunchClaimClosesThePopup(t *testing.T) {
	claimedID := "550e8400-e29b-41d4-a716-446655440000"
	var detached bool
	m := launchModel(t, claimedID, &detached)
	m = apply(m, "enter")
	if m.mode != modeRuns || !strings.Contains(m.View().Content, "STARTING") {
		t.Fatalf("launch must show STARTING until the ack:\n%s", m.View().Content)
	}
	next, cmd := m.Update(launchAckMsg{Line: "@hwf-history:claimed " + claimedID})
	m = next.(Model)
	if !m.quit || cmd == nil {
		t.Fatalf("a claimed launch must quit the popup: quit=%v cmd=%v", m.quit, cmd != nil)
	}
	if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Fatal("a claimed launch must return tea.Quit")
	}
	if !detached {
		t.Fatal("a claimed launch must detach the child before quitting")
	}

	unavailableID := "550e8400-e29b-41d4-a716-446655440001"
	detached = false
	m2 := apply(launchModel(t, unavailableID, &detached), "enter")
	m2 = applyMsg(m2, launchAckMsg{Line: "@hwf-history:unavailable " + unavailableID})
	if m2.quit {
		t.Fatal("a launch with no history entry must keep the popup open")
	}
	if !strings.Contains(m2.View().Content, "HISTORY UNAVAILABLE") {
		t.Fatalf("history unavailable must stay visible:\n%s", m2.View().Content)
	}

	rejectedID := "550e8400-e29b-41d4-a716-446655440002"
	detached = false
	m3 := apply(launchModel(t, rejectedID, &detached), "enter")
	m3 = applyMsg(m3, launchAckMsg{Line: "@hwf-history:rejected " + rejectedID + " already claimed"})
	if m3.quit {
		t.Fatal("a rejected launch must keep the popup open")
	}
	body := m3.View().Content
	if !strings.Contains(body, "LAUNCH FAILED") {
		t.Fatalf("a rejected launch must show why:\n%s", body)
	}
	if !strings.Contains(body, "already claimed") {
		t.Fatalf("a rejected launch must show the reason text:\n%s", body)
	}

	detached = false
	m4 := apply(launchModel(t, "550e8400-e29b-41d4-a716-446655440004", &detached), "enter")
	m4 = apply(m4, "esc")
	if !detached {
		t.Fatal("Escape from an active launch must detach child observation")
	}
	if m4.mode != modeRuns || !m4.runs.IsList() {
		t.Fatalf("Escape must return to the Runs list, mode=%v list=%v", m4.mode, m4.runs.IsList())
	}
}

func TestParityPrintableKFilters(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80})
	m = apply(m, "k")
	if m.filter != "k" || m.mode != modeList {
		t.Fatalf("filter=%q mode=%v", m.filter, m.mode)
	}
}

func TestParityPaletteLettersHandoff(t *testing.T) {
	root := t.TempDir()
	deployPath := root + "/deploy.yaml"
	if err := os.WriteFile(deployPath, []byte("version: v1alpha1\nsteps:\n  - run: [echo, hi]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	entries := []workflow.ListEntry{
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
		ExportShare: func(entry workflow.ListEntry) (string, error) {
			return `hwf workflow import "bundle-` + entry.Name + `"`, nil
		},
	})
	m = apply(m, "ctrl+p", "n")
	if m.quit || m.mode != modeNewMode {
		t.Fatalf("new must offer agent or template, quit=%v mode=%v", m.quit, m.mode)
	}
	m = apply(m, "down", "enter")
	if m.mode != modeNewName {
		t.Fatalf("template must prompt for name, mode=%v", m.mode)
	}
	m = apply(m, "s", "h", "i", "p", "enter")
	if m.mode != modeNewScope {
		t.Fatalf("name must go to scope chooser, mode=%v", m.mode)
	}
	m = apply(m, "enter")
	if m.mode != modeEditPlace {
		t.Fatalf("scope must go to placement chooser, mode=%v", m.mode)
	}
	m = apply(m, "enter")
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
	m = apply(m, "ctrl+p", "i")
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
	m = apply(m, "ctrl+p", "o")
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
	m = apply(m, "down", "ctrl+p", "e", "enter")
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
		ExportShare: func(entry workflow.ListEntry) (string, error) {
			return `hwf workflow import "bundle-` + entry.Name + `"`, nil
		},
	})
	copied, notified = "", nil
	m = apply(m, "down", "ctrl+p", "s")
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
	dir := t.TempDir()
	path := dir + "/deploy.yaml"
	if err := os.WriteFile(path, []byte("name: deploy\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	entry := workflow.ListEntry{Name: "deploy", Source: "repo", File: path, Title: "Deploy"}
	m := New(Options{Entries: []workflow.ListEntry{entry}, Width: 80})
	m = apply(m, "ctrl+p", "d", "n")
	if m.mode != modeList {
		t.Fatalf("mode = %v", m.mode)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("file removed on cancel: %v", err)
	}
}
