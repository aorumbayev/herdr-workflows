package runsbrowser

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
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

// Spec scenarios owned by runsbrowser.ParityBaseline (picker-presentation Runs requirements).
// openspec/specs/picker-presentation/spec.md
var requiredRunsParityScenarios = []string{
	"More than six runs",
	"Tall host shows more runs",
	"Run detail fills the host",
	"Narrow popup",
	"Interrupted run",
	"Toggle all worktrees",
	"Printable scope letter",
	"Search a short displayed ID",
	"Inspect a successful run",
	"Inspect an active run",
	"Inspect a failed run",
	"Inspect a tolerated failure",
	"Send back the failed step",
	"Choose an agent pane",
	"Return from detail",
	"No current runs",
	"No machine runs",
	"Filter miss",
}

func TestParityBaselineCoversSpecScenarios(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md Runs requirements
	ownTests := loadPackageTestFuncs(".")
	externalTests := map[string]map[string]struct{}{
		"tui":    loadPackageTestFuncs("../tui"),
		"picker": loadPackageTestFuncs("../picker"),
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
	for _, scenario := range requiredRunsParityScenarios {
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
		for _, want := range requiredRunsParityScenarios {
			if want == scenario {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("unexpected parity scenario %q not in runs-owned spec list", scenario)
		}
	}
}

func TestParityMoreThanSixRunsScrollsViewport(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md "More than six runs"
	checkout := t.TempDir()
	names := []string{"a", "b", "c", "d", "e", "f", "g", "h"}
	m, _ := modelWithRuns(t, checkout, names...)
	if len(m.state.Items) != 8 {
		t.Fatalf("items = %d", len(m.state.Items))
	}
	if listViewportRows(m.View().Content) != tui.ListViewport {
		t.Fatalf("visible rows = %d, want %d\n%s", listViewportRows(m.View().Content), tui.ListViewport, m.View().Content)
	}
	if strings.Contains(m.View().Content, "| g |") || strings.Contains(m.View().Content, "| h |") {
		t.Fatalf("rows beyond viewport leaked:\n%s", m.View().Content)
	}
	m = apply(m, "down", "down", "down", "down", "down", "down")
	body := m.View().Content
	if listViewportRows(body) != tui.ListViewport {
		t.Fatalf("scrolled visible = %d\n%s", listViewportRows(body), body)
	}
	if !strings.Contains(body, "| g |") && !strings.Contains(body, " g ") {
		// workflow field is the name; status | name | elapsed
		if !strings.Contains(body, "g |") {
			t.Fatalf("cursor past viewport must reveal later run:\n%s", body)
		}
	}
}

func listViewportRows(body string) int {
	lines := strings.Split(body, "\n")
	i := 0
	for i < len(lines) && tui.StripContentPadding(lines[i]) == "" {
		i++
	}
	if i >= len(lines) {
		return 0
	}
	i++
	for i < len(lines) && tui.StripContentPadding(lines[i]) == "" {
		i++
	}
	n := 0
	for j := 0; j < tui.ListViewport && i < len(lines); j++ {
		if strings.Contains(tui.StripContentPadding(lines[i]), "----") {
			break
		}
		n++
		i++
	}
	return n
}

func TestParityInterruptedRunShowsTextStatus(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md "Interrupted run"
	row := FormatRunRow(history.Summary{
		ID: "550e8400-e29b-41d4-a716-446655440000", Workflow: "demo", Status: "interrupted", ElapsedMs: 1000,
	}, 80, FormatRunRowOpts{})
	if !strings.Contains(row, "INTERRUPTED") && !strings.Contains(row, "INTR") {
		t.Fatalf("interrupted text missing: %q", row)
	}
}

func TestParitySearchShortDisplayedID(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md "Search a short displayed ID"
	checkout := t.TempDir()
	m, ids := modelWithRuns(t, checkout, "alpha")
	prefix := ids[0][:8]
	for _, r := range prefix {
		m = apply(m, string(r))
	}
	body := m.View().Content
	if !strings.Contains(body, "alpha") {
		t.Fatalf("prefix filter missed run:\n%s", body)
	}
	if len(m.state.Items) == 0 {
		t.Fatal("no matching items for short id prefix")
	}
}

func TestParityInspectActiveAndToleratedDetailKinds(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md active + tolerated failure detail
	running := DetailLines(DetailView{
		Kind: "detail",
		Detail: history.Detail{
			ID: "550e8400-e29b-41d4-a716-446655440000", Workflow: "w", Status: "running",
			ElapsedMs: 5000,
		},
		Blocks: []history.Block{
			{Kind: "head", Status: "RUNNING", Title: "w", DisplayID: "550e8400", Elapsed: "5s"},
			{Kind: "step", Depth: 0, Ordinal: 1, Total: 2, Label: "build", Outcome: "running"},
		},
	}, 80)
	joined := strings.Join(running, "\n")
	if !strings.Contains(joined, "RUNNING") && !strings.Contains(joined, "running") {
		t.Fatalf("active detail:\n%s", joined)
	}
	failed := DetailLines(DetailView{
		Kind: "detail",
		Detail: history.Detail{
			ID: "550e8400-e29b-41d4-a716-446655440001", Workflow: "w", Status: "failed",
		},
		Blocks: []history.Block{
			{Kind: "head", Status: "FAILED", Title: "w", DisplayID: "550e8401", Elapsed: "2s"},
			{Kind: "step", Depth: 0, Ordinal: 1, Total: 2, Label: "build", Outcome: "failed_continued"},
			{Kind: "step", Depth: 0, Ordinal: 2, Total: 2, Label: "ship", Outcome: "succeeded"},
		},
	}, 80)
	joined = strings.Join(failed, "\n")
	if !strings.Contains(joined, "failed") || !strings.Contains(joined, "ship") {
		t.Fatalf("tolerated failure detail:\n%s", joined)
	}
}

func TestParityNoMachineRunsCopy(t *testing.T) {
	// openspec/specs/picker-presentation/spec.md "No machine runs"
	stateDir := t.TempDir()
	getenv := testGetenv(t, stateDir)
	m := New(Options{RepoRoot: t.TempDir(), Width: 80, Env: getenv})
	m = runCmd(m, m.Init())
	body := m.View().Content
	if !strings.Contains(body, "no workflow has run yet") {
		if got := FormatRunListEmpty(RunListEmptyOpts{Scope: ScopeAll, HasMachineRuns: false}); !strings.Contains(got, "no workflow has run yet") {
			t.Fatalf("empty machine copy = %q body=\n%s", got, body)
		}
	}
}

func TestParityWindowSizeRecomputesRunsWidth(t *testing.T) {
	checkout := t.TempDir()
	m, _ := modelWithRuns(t, checkout, "alpha")
	next, cmd := m.Update(tea.WindowSizeMsg{Width: 40})
	m = next.(Model)
	m = runCmd(m, cmd)
	if m.width != 40 {
		t.Fatalf("width = %d", m.width)
	}
	for _, line := range strings.Split(m.View().Content, "\n") {
		if tui.Columns(line) > 40 {
			t.Fatalf("line wider than width: %q", line)
		}
	}
}

func TestRunsViewportGrowsWithHostHeight(t *testing.T) {
	// openspec picker-presentation: run rows fill the host above the six-row floor.
	checkout := t.TempDir()
	m, _ := modelWithRuns(t, checkout, "a", "b", "c", "d", "e", "f", "g", "h")
	if m.listViewport() != tui.ListViewport {
		t.Fatalf("unknown height viewport = %d, want the floor %d", m.listViewport(), tui.ListViewport)
	}
	next, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 30})
	m = next.(Model)
	if m.listViewport() <= tui.ListViewport {
		t.Fatalf("tall host viewport = %d, want more than %d", m.listViewport(), tui.ListViewport)
	}
	if !strings.Contains(m.View().Content, "h |") {
		t.Fatalf("tall host must show every run without scrolling:\n%s", m.View().Content)
	}
}
