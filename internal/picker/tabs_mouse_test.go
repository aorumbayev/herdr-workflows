package picker

import (
	"strconv"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

func TestTabCyclesWorkflowsRuns(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80, RepoRoot: t.TempDir()})
	body := m.View().Content
	if !strings.Contains(body, tui.TabWorkflows) || !strings.Contains(body, tui.TabRuns) {
		t.Fatalf("tab bar missing:\n%s", body)
	}
	tabBar := strings.Split(body, "\n")[0]
	if strings.Contains(tabBar, "console") {
		t.Fatalf("overlay must not show a console tab:\n%s", body)
	}
	m = apply(m, "tab")
	if m.mode != modeRuns {
		t.Fatalf("mode = %v", m.mode)
	}
	m = apply(m, "tab")
	if m.mode != modeList {
		t.Fatalf("mode = %v, want the workflows tab after two cycles", m.mode)
	}
}

func TestTabNeverQuitsTheOverlay(t *testing.T) {
	var reopened []PopupState
	newModel := func() Model {
		return New(Options{
			Entries:     catalogEntries(),
			Width:       80,
			RepoRoot:    t.TempDir(),
			ReopenPopup: func(state PopupState) error { reopened = append(reopened, state); return nil },
		})
	}
	m := apply(newModel(), "tab") // workflows -> runs
	if m.quit {
		t.Fatal("tab from workflows must not quit the overlay")
	}
	m = apply(m, "tab") // runs -> workflows
	if m.quit {
		t.Fatal("tab from runs must not quit the overlay")
	}
	if len(reopened) != 0 {
		t.Fatalf("tab must not respawn the popup, got %+v", reopened)
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
	m = applyMsg(m, tea.MouseClickMsg{Button: tea.MouseLeft, X: tui.ChromePaddingX + tabCellX(tui.TabRuns), Y: 0})
	if m.mode != modeRuns {
		t.Fatalf("click runs = %v", m.mode)
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
	for _, cell := range tabCells() {
		if cell.name == name {
			return x + 1
		}
		x += cell.width + 1
	}
	return 0
}

// rowHasAttr is true when any SGR sequence in line opens with attribute attr.
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
	// title keeps the foreground of the user so no theme can remove it.
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
	m = apply(m, "ctrl+p")
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
	m = apply(m, "ctrl+p")
	m = apply(m, "c")
	if m.mode != modeConsolePlace {
		t.Fatalf("mode = %v, want the placement chooser", m.mode)
	}
	m = applyMsg(m, press("esc"))
	if m.mode != modeList {
		t.Fatalf("mode = %v, want the workflows tab", m.mode)
	}
	if m.filter != "de" {
		t.Fatalf("filter = %q, want the typed filter kept", m.filter)
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
