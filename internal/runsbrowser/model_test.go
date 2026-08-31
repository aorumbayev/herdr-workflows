package runsbrowser

import (
	"os"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/charmbracelet/x/ansi"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

func press(s string) tea.KeyPressMsg {
	switch s {
	case "up":
		return tea.KeyPressMsg{Code: tea.KeyUp}
	case "down":
		return tea.KeyPressMsg{Code: tea.KeyDown}
	case "enter":
		return tea.KeyPressMsg{Code: tea.KeyEnter}
	case "esc":
		return tea.KeyPressMsg{Code: tea.KeyEscape}
	case "tab":
		return tea.KeyPressMsg{Code: tea.KeyTab}
	case "backspace":
		return tea.KeyPressMsg{Code: tea.KeyBackspace}
	case "ctrl+g":
		return tea.KeyPressMsg{Code: 'g', Mod: tea.ModCtrl}
	default:
		r := []rune(s)
		return tea.KeyPressMsg{Text: s, Code: r[0]}
	}
}

func runCmd(m Model, cmd tea.Cmd) Model {
	for cmd != nil {
		msg := cmd()
		if msg == nil {
			return m
		}
		next, nextCmd := m.Update(msg)
		m = next.(Model)
		cmd = nextCmd
	}
	return m
}

func apply(m Model, keys ...string) Model {
	for _, k := range keys {
		next, cmd := m.Update(press(k))
		m = next.(Model)
		m = runCmd(m, cmd)
	}
	return m
}

func testGetenv(t *testing.T, stateDir string) config.Env {
	t.Helper()
	return func(key string) string {
		if key == "HERDR_PLUGIN_STATE_DIR" {
			return stateDir
		}
		return os.Getenv(key)
	}
}

func modelWithRuns(t *testing.T, checkout string, workflows ...string) (Model, []string) {
	t.Helper()
	stateDir := t.TempDir()
	getenv := testGetenv(t, stateDir)
	ids := make([]string, len(workflows))
	for i, name := range workflows {
		started := time.Now().Add(-time.Duration(i) * time.Second).UTC().Format("2006-01-02T15:04:05.000Z")
		id := writeSucceededRun(t, getenv, checkout, name, started)
		ids[i] = id
	}
	m := New(Options{RepoRoot: checkout, Width: 80, Env: getenv})
	m = runCmd(m, m.Init())
	return m, ids
}

func TestCtrlGTogglesScopeFooter(t *testing.T) {
	checkout := t.TempDir()
	m, _ := modelWithRuns(t, checkout, "alpha")
	body := m.View().Content
	if !strings.Contains(body, "ctrl+g Current") {
		t.Fatalf("current footer missing:\n%s", body)
	}
	m = apply(m, "ctrl+g")
	body = m.View().Content
	if !strings.Contains(body, "ctrl+g All") {
		t.Fatalf("all footer missing:\n%s", body)
	}
	m = apply(m, "ctrl+g")
	if !strings.Contains(m.View().Content, "ctrl+g Current") {
		t.Fatalf("toggle back failed:\n%s", m.View().Content)
	}
}

func TestEnterShowsDetailEscapeRestoresSelection(t *testing.T) {
	checkout := t.TempDir()
	m, ids := modelWithRuns(t, checkout, "alpha", "bravo")
	m = apply(m, "down", "enter")
	body := m.View().Content
	if !strings.Contains(body, "SUCCEEDED") || !strings.Contains(body, "bravo") {
		t.Fatalf("detail missing:\n%s", body)
	}
	m = apply(m, "esc")
	body = m.View().Content
	if !strings.Contains(body, tui.FilterRuns) && !strings.HasPrefix(body, "filter") {
		t.Fatalf("list filter missing:\n%s", body)
	}
	if !strings.Contains(body, "> ") || !strings.Contains(body, "bravo") {
		t.Fatalf("selection not restored:\n%s", body)
	}
	if m.state.SelectedID != ids[1] {
		t.Fatalf("selected = %q want %q", m.state.SelectedID, ids[1])
	}
}

func TestOverlappingDetailLatestWins(t *testing.T) {
	checkout := t.TempDir()
	m, ids := modelWithRuns(t, checkout, "one", "two")
	next, cmd1 := m.Update(press("enter"))
	m = next.(Model)
	next, _ = m.Update(press("esc"))
	m = next.(Model)
	m = apply(m, "down", "enter")
	next, cmd2 := m.Update(press("enter"))
	m = next.(Model)
	if cmd1 != nil {
		next, _ = m.Update(cmd1())
		m = next.(Model)
	}
	if cmd2 != nil {
		next, _ = m.Update(cmd2())
		m = next.(Model)
	}
	body := m.View().Content
	if strings.Contains(body, "one") && !strings.Contains(body, "two") {
		t.Fatalf("stale detail won:\n%s", body)
	}
	if !strings.Contains(body, "two") {
		t.Fatalf("latest detail missing:\n%s", body)
	}
	_ = ids
}

func TestFilterMissKeepsFilterRow(t *testing.T) {
	checkout := t.TempDir()
	m, _ := modelWithRuns(t, checkout, "alpha")
	width := m.contentWidth()
	if got := tui.StripContentPadding(strings.Split(m.View().Content, "\n")[1]); got != tui.FormatField("", tui.FilterRuns, width) {
		t.Fatalf("empty filter = %q", got)
	}
	m = apply(m, "z", "z", "z")
	body := m.View().Content
	if got := tui.StripContentPadding(strings.Split(body, "\n")[1]); got != tui.FieldCursor+"  zzz" {
		t.Fatalf("typed filter = %q", got)
	}
	if got := ansi.Strip(tui.StripContentPadding(strings.Split(body, "\n")[2])); got != tui.FormatFieldEdge(width) {
		t.Fatalf("field edge = %q", got)
	}
	if !strings.Contains(body, "no matching runs") {
		t.Fatalf("miss copy:\n%s", body)
	}
}

func TestEmptyCurrentShowsCtrlGHint(t *testing.T) {
	stateDir := t.TempDir()
	getenv := testGetenv(t, stateDir)
	other := t.TempDir()
	checkout := t.TempDir()
	writeSucceededRun(t, getenv, other, "foreign", time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	m := New(Options{RepoRoot: checkout, Width: 80, Env: getenv})
	m = runCmd(m, m.Init())
	body := m.View().Content
	if !strings.Contains(body, "no runs in this worktree") || !strings.Contains(body, "Ctrl+G for All") {
		t.Fatalf("empty current copy:\n%s", body)
	}
}

func TestPrintableGEntersFilter(t *testing.T) {
	checkout := t.TempDir()
	m, _ := modelWithRuns(t, checkout, "alpha")
	m = apply(m, "g")
	if m.filter != "g" {
		t.Fatalf("filter = %q", m.filter)
	}
	if !strings.Contains(m.View().Content, "ctrl+g Current") {
		t.Fatalf("scope changed on printable g:\n%s", m.View().Content)
	}
}

func TestTabEmitsSwitchToWorkflows(t *testing.T) {
	checkout := t.TempDir()
	m, _ := modelWithRuns(t, checkout, "alpha")
	next, cmd := m.Update(press("tab"))
	if cmd == nil {
		t.Fatal("tab must emit cmd")
	}
	msg := cmd()
	if _, ok := msg.(SwitchToWorkflowsMsg); !ok {
		t.Fatalf("msg = %#v", msg)
	}
	_ = next
}

func TestTabIgnoredInDetail(t *testing.T) {
	checkout := t.TempDir()
	m, _ := modelWithRuns(t, checkout, "alpha")
	m = apply(m, "enter")
	next, cmd := m.Update(press("tab"))
	if cmd != nil {
		if msg := cmd(); msg != nil {
			t.Fatalf("tab in detail emitted %T", msg)
		}
	}
	if next.(Model).screen != screenDetail {
		t.Fatal("detail screen changed on tab")
	}
}
