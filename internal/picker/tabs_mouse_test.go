package picker

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/console"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestTabCyclesWorkflowsRunsConsole(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80, RepoRoot: t.TempDir()})
	body := m.View().Content
	if !strings.Contains(body, tui.TabWorkflows) || !strings.Contains(body, tui.TabRuns) || !strings.Contains(body, tui.TabConsole) {
		t.Fatalf("tab bar missing:\n%s", body)
	}
	m = apply(m, "tab")
	if m.mode != modeRuns {
		t.Fatalf("mode = %v", m.mode)
	}
	m = apply(m, "tab")
	if m.mode != modeConsole {
		t.Fatalf("mode = %v", m.mode)
	}
	if !strings.Contains(m.View().Content, tui.ConsoleHint) && !strings.Contains(m.View().Content, "p pop out") {
		t.Fatalf("console tab missing pop-out hint:\n%s", m.View().Content)
	}
	m = apply(m, "tab")
	if m.mode != modeList {
		t.Fatalf("mode = %v", m.mode)
	}
}

func TestConsoleTabPOpensPlacement(t *testing.T) {
	var opened bool
	m := New(Options{
		Entries:  catalogEntries(),
		Width:    80,
		RepoRoot: t.TempDir(),
		OpenConsole: func(console.Placement) error {
			opened = true
			return nil
		},
	})
	m = apply(m, "tab", "tab")
	if m.mode != modeConsole {
		t.Fatalf("mode = %v", m.mode)
	}
	m = apply(m, "p")
	if m.mode != modeConsolePlace {
		t.Fatalf("mode = %v want placement", m.mode)
	}
	if opened {
		t.Fatal("placement must wait for enter")
	}
}

func TestPickerHoverStyleIsNotReverse(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80})
	m.cursor = 0
	m.hoverRow = 1
	rows := listRowLines(m.View().Content)
	if len(rows) < 2 {
		t.Fatalf("rows = %d", len(rows))
	}
	if !rowHasAttr(rows[0], "7") || rowHasAttr(rows[0], "4") {
		t.Fatalf("cursor row must reverse and must not underline: %q", rows[0])
	}
	if !rowHasAttr(rows[1], "4") || rowHasAttr(rows[1], "7") {
		t.Fatalf("hover row must underline and must not reverse: %q", rows[1])
	}
}

func TestReverseCursorWinsOverHoverOnTheSameRow(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80})
	m.cursor = 1
	m.hoverRow = 1
	row := listRowLines(m.View().Content)[1]
	if !rowHasAttr(row, "7") || rowHasAttr(row, "4") {
		t.Fatalf("reverse must win on the hovered cursor row: %q", row)
	}
}

func TestPickerMouseReportsAndMovesCursor(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80})
	if m.View().MouseMode != tea.MouseModeAllMotion {
		t.Fatalf("MouseMode = %v", m.View().MouseMode)
	}
	if FilterInput(nil, tea.MouseMotionMsg{X: 2, Y: 3}) == nil {
		t.Fatal("FilterInput must keep mouse")
	}
	wheeled := applyMsg(m, tea.MouseWheelMsg{Button: tea.MouseWheelDown, X: 3, Y: 4})
	keyed := apply(m, "down")
	if wheeled.cursor != keyed.cursor || wheeled.cursor != 1 {
		t.Fatalf("wheel cursor = %d, key cursor = %d, want 1", wheeled.cursor, keyed.cursor)
	}
	if up := applyMsg(wheeled, tea.MouseWheelMsg{Button: tea.MouseWheelUp, X: 3, Y: 4}); up.cursor != 0 {
		t.Fatalf("wheel up cursor = %d", up.cursor)
	}
	clicked := applyMsg(m, tea.MouseClickMsg{Button: tea.MouseLeft, X: tui.ChromePaddingX + 3, Y: listBodyStartRow + 1})
	if clicked.cursor != 1 {
		t.Fatalf("pointer select cursor = %d, want 1", clicked.cursor)
	}
	hovered := applyMsg(m, tea.MouseMotionMsg{X: tui.ChromePaddingX + 3, Y: listBodyStartRow + 2})
	if hovered.hoverRow != 2 || hovered.cursor != 0 {
		t.Fatalf("hover row = %d cursor = %d", hovered.hoverRow, hovered.cursor)
	}
}

func TestTabBarClickSwitchesAndObeysTheKeyboardGuard(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80, RepoRoot: t.TempDir()})
	m = applyMsg(m, tea.MouseClickMsg{Button: tea.MouseLeft, X: tui.ChromePaddingX + tabCellX(tui.TabConsole), Y: 0})
	if m.mode != modeConsole {
		t.Fatalf("click console = %v", m.mode)
	}
	m = applyMsg(m, tea.MouseClickMsg{Button: tea.MouseLeft, X: tui.ChromePaddingX + tabCellX(tui.TabWorkflows), Y: 0})
	if m.mode != modeList {
		t.Fatalf("click workflows = %v", m.mode)
	}
	m = apply(m, "tab")
	m = applyMsg(m, tea.KeyPressMsg{Code: tea.KeyEnter})
	if m.runs.IsList() {
		t.Skip("runs browser stayed in list mode without run history")
	}
	before := m.mode
	m = applyMsg(m, tea.MouseClickMsg{Button: tea.MouseLeft, X: tui.ChromePaddingX + tabCellX(tui.TabWorkflows), Y: 0})
	if m.mode != before {
		t.Fatalf("pointer left run detail where Tab cannot: %v", m.mode)
	}
}

func tabCellX(name string) int {
	x := 0
	for _, n := range []string{tui.TabWorkflows, tui.TabRuns, tui.TabConsole} {
		if n == name {
			return x + 1
		}
		x += len(n) + 3
	}
	return 0
}

// rowHasAttr reports whether any SGR sequence in line opens with attribute attr.
func rowHasAttr(line, attr string) bool {
	for _, chunk := range strings.Split(line, "\x1b[")[1:] {
		end := strings.Index(chunk, "m")
		if end < 0 {
			continue
		}
		params := strings.Split(chunk[:end], ";")
		if params[0] == attr {
			return true
		}
	}
	return false
}

func listRowLines(view string) []string {
	lines := strings.Split(view, "\n")
	out := make([]string, 0, tui.ListViewport)
	for i := 0; i < tui.ListViewport && listBodyStartRow+i < len(lines); i++ {
		out = append(out, lines[listBodyStartRow+i])
	}
	return out
}

func TestRowTextFollowsTheTerminalForeground(t *testing.T) {
	// Only the warning marker and an invalid location pin a palette slot. The
	// title keeps the user's own foreground so no theme can wash it out.
	repo := tui.FormatStyledRow("Fine", "repo", false, 60, false, false)
	if strings.Contains(repo, "38;5;") {
		t.Fatalf("a clean row must not pin any palette slot: %q", repo)
	}
	if !strings.Contains(repo, "\x1b[2m") {
		t.Fatalf("the location column must be faint: %q", repo)
	}
	if !strings.Contains(repo, "Fine") || !strings.Contains(repo, "repo") {
		t.Fatalf("row text missing: %q", repo)
	}
}

func TestInvalidLocationAndWarnMarkerUseWarnSlot(t *testing.T) {
	warnFG := "38;5;" + strconv.Itoa(tui.WarnIndex)
	invalid := tui.FormatStyledRow("Broken", "invalid", true, 60, false, false)
	if strings.Count(invalid, warnFG) != 2 {
		t.Fatalf("invalid location and ! must both use warn %s: %q", warnFG, invalid)
	}
	if !strings.Contains(invalid, "invalid") || !strings.Contains(invalid, "!") {
		t.Fatalf("warn colors must not replace the text: %q", invalid)
	}
	repo := tui.FormatStyledRow("Fine", "repo", false, 60, false, false)
	if strings.Contains(repo, warnFG) {
		t.Fatalf("clean row must not use warn: %q", repo)
	}
}

func TestMissingEditorIsAHardError(t *testing.T) {
	m := New(Options{
		Entries: catalogEntries(),
		Width:   80,
		Env:     func(string) string { return "" },
	})
	m = apply(m, "ctrl+k")
	next, _ := m.Update(press("o"))
	m = next.(Model)
	if m.mode != modeEditPlace {
		t.Fatalf("mode = %v, want edit place", m.mode)
	}
	next, cmd := m.Update(press("enter"))
	m = next.(Model)
	if cmd == nil {
		t.Fatal("open must report the missing editor")
	}
	m = runCmd(m, cmd)
	if !strings.Contains(m.status, "EDITOR") || !strings.Contains(m.status, "VISUAL") {
		t.Fatalf("status = %q, want EDITOR and VISUAL named", m.status)
	}
}

func TestPopOutEscapeKeepsTheWorkflowFilter(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80, Height: 30})
	m = apply(m, "d", "e")
	m = applyMsg(m, press("tab"))
	m = applyMsg(m, press("tab"))
	if m.mode != modeConsole {
		t.Fatalf("mode = %v, want console", m.mode)
	}
	m = applyMsg(m, press("p"))
	if m.mode != modeConsolePlace {
		t.Fatalf("mode = %v, want the placement chooser", m.mode)
	}
	m = applyMsg(m, press("esc"))
	if m.mode != modeConsole {
		t.Fatalf("mode = %v, want the console tab", m.mode)
	}
	if m.filter != "de" {
		t.Fatalf("filter = %q, want the typed filter kept", m.filter)
	}
}

func TestConsoleTabRedrawsAfterAResizeOnAnotherTab(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80, Height: 30})
	m = applyMsg(m, press("tab"))
	m = applyMsg(m, press("tab"))
	m = applyMsg(m, press("tab"))
	m = applyMsg(m, tea.WindowSizeMsg{Width: 80, Height: 12})
	m = applyMsg(m, press("tab"))
	m = applyMsg(m, press("tab"))
	if got := len(strings.Split(m.View().Content, "\n")); got != 12 {
		t.Fatalf("console frame = %d lines, want 12", got)
	}
}

func TestConsoleTabSeesWorkflowsAddedAfterItsFirstVisit(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80, Height: 30})
	m = applyMsg(m, press("tab"))
	m = applyMsg(m, press("tab"))
	m = applyMsg(m, press("tab"))
	m.entries = append(m.entries, workflow.ListEntry{Name: "fresh-one", Title: "Fresh One", Source: "repo"})
	m.entriesRev++
	m = applyMsg(m, press("tab"))
	m = applyMsg(m, press("tab"))
	if !strings.Contains(m.View().Content, "Fresh One") {
		t.Fatalf("console tab missed a workflow added this session:\n%s", m.View().Content)
	}
}

func TestTabBarClickOnTheActiveRunsTabKeepsItsState(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80, Height: 30})
	m = applyMsg(m, press("tab"))
	if m.mode != modeRuns {
		t.Fatalf("mode = %v, want runs", m.mode)
	}
	m = applyMsg(m, press("ctrl+g"))
	before := m.View().Content
	m = applyMsg(m, tea.MouseClickMsg{Button: tea.MouseLeft, X: tui.ChromePaddingX + len(tui.TabWorkflows) + 3, Y: 0})
	if m.mode != modeRuns {
		t.Fatalf("mode = %v, want runs", m.mode)
	}
	if m.View().Content != before {
		t.Fatalf("clicking the active tab rebuilt the runs browser:\nbefore:\n%s\nafter:\n%s", before, m.View().Content)
	}
}

func TestConsoleTabForwardsDiagramClick(t *testing.T) {
	path := filepath.Join("..", "..", "examples", "handoff.yaml")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	def, err := workflow.ParseWorkflowText("handoff", string(body), config.Config{}, t.TempDir(), path)
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{
		Entries: []workflow.ListEntry{{Name: "handoff", Title: "Handoff", Source: "repo", File: path}},
		Width:   80,
		Height:  24,
		LoadWorkflow: func(entry workflow.ListEntry) (*workflow.Definition, error) {
			return def, nil
		},
	})
	m = apply(m, "tab", "tab")
	if m.mode != modeConsole {
		t.Fatalf("mode = %v", m.mode)
	}
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	m = applyMsg(m, tea.MouseClickMsg{Button: tea.MouseLeft, X: tui.ChromePaddingX + 2, Y: 3})
	if m.console.AtRoot() {
		t.Fatal("expected diagram after enter")
	}
}

func TestConsoleTabForwardsDiagramWheel(t *testing.T) {
	path := filepath.Join("..", "..", "examples", "handoff.yaml")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	def, err := workflow.ParseWorkflowText("handoff", string(body), config.Config{}, t.TempDir(), path)
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{
		Entries: []workflow.ListEntry{{Name: "handoff", Title: "Handoff", Source: "repo", File: path}},
		Width:   80,
		Height:  24,
		LoadWorkflow: func(entry workflow.ListEntry) (*workflow.Definition, error) {
			return def, nil
		},
	})
	m = apply(m, "tab", "tab")
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	before := m.console.Body()
	m = applyMsg(m, tea.MouseWheelMsg{Button: tea.MouseWheelDown, X: tui.ChromePaddingX + 2, Y: 4})
	after := m.console.Body()
	if after == before {
		t.Fatal("wheel did not change the embedded diagram")
	}
}

func TestConsoleTabOpensSelectedDiagram(t *testing.T) {
	path := filepath.Join("..", "..", "examples", "handoff.yaml")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	def, err := workflow.ParseWorkflowText("handoff", string(body), config.Config{}, t.TempDir(), path)
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{
		Entries: []workflow.ListEntry{
			{Name: "alpha", Title: "Alpha", Source: "repo", File: path},
			{Name: "handoff", Title: "Handoff", Source: "repo", File: path},
		},
		Width:        80,
		Height:       24,
		LoadWorkflow: func(entry workflow.ListEntry) (*workflow.Definition, error) { return def, nil },
	})
	m = apply(m, "down", "tab", "tab")
	if m.mode != modeConsole {
		t.Fatalf("mode = %v, want console", m.mode)
	}
	if m.console.AtRoot() {
		t.Fatalf("console tab must open the selected diagram, not a second list:\n%s", m.console.Body())
	}
	if !strings.Contains(ansi.Strip(m.console.Body()), "Handoff") {
		t.Fatalf("diagram must be the selected workflow:\n%s", ansi.Strip(m.console.Body()))
	}
	back := applyMsg(m, tea.KeyPressMsg{Code: tea.KeyEsc})
	if back.mode != modeList {
		t.Fatalf("esc on the diagram must return to the workflows tab, mode = %v", back.mode)
	}
	cycled := apply(m, "tab")
	if cycled.mode != modeList {
		t.Fatalf("tab on the diagram must cycle to the workflows tab, mode = %v", cycled.mode)
	}
}
