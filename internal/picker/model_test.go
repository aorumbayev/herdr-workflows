package picker

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func eightEntries() []workflow.ListEntry {
	names := []string{"alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"}
	out := make([]workflow.ListEntry, len(names))
	for i, name := range names {
		out[i] = workflow.ListEntry{Name: name, Source: "repo", File: "/r/" + name + ".yaml", Title: strings.ToUpper(name[:1]) + name[1:]}
	}
	return out
}

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
	case "ctrl+p":
		return tea.KeyPressMsg{Code: 'p', Mod: tea.ModCtrl}
	case "ctrl+g":
		return tea.KeyPressMsg{Code: 'g', Mod: tea.ModCtrl}
	case "ctrl+c":
		return tea.KeyPressMsg{Code: 'c', Mod: tea.ModCtrl}
	case "y":
		return tea.KeyPressMsg{Text: "y", Code: 'y'}
	case "n":
		return tea.KeyPressMsg{Text: "n", Code: 'n'}
	default:
		r := []rune(s)
		return tea.KeyPressMsg{Text: s, Code: r[0]}
	}
}

func apply(m Model, keys ...string) Model {
	for _, k := range keys {
		next, cmd := m.Update(press(k))
		m = next.(Model)
		m = runCmd(m, cmd)
	}
	return m
}

func applyMsg(m Model, msg tea.Msg) Model {
	next, cmd := m.Update(msg)
	m = next.(Model)
	return runCmd(m, cmd)
}

// runCmd drains a command chain. The embedded console arms its file-watch
// tick again each time, so the pump stops after a bounded number of rounds.
func runCmd(m Model, cmd tea.Cmd) Model {
	for round := 0; cmd != nil && round < 2; round++ {
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

func listRowCount(view string) int {
	lines := strings.Split(view, "\n")
	i := 0
	skipBlank := func() {
		for i < len(lines) && visibleLine(lines[i]) == "" {
			i++
		}
	}
	skipBlank()
	i++
	skipBlank()
	i++
	skipBlank()
	n := 0
	for j := 0; j < tui.ListViewport && i < len(lines); j++ {
		line := visibleLine(lines[i])
		if strings.Contains(line, "----") {
			break
		}
		if strings.HasPrefix(line, "> ") || strings.HasPrefix(line, "  ") {
			n++
		}
		i++
	}
	return n
}

func visibleLine(line string) string {
	return ansi.Strip(tui.StripContentPadding(line))
}

func TestPickerViewportShowsSixRowsAndScrolls(t *testing.T) {
	// This test copies picker-presentation: six-row viewport, scroll to keep cursor visible, wrap-around.
	m := New(Options{Entries: eightEntries(), Width: 62})
	body := m.View().Content
	if listRowCount(body) != tui.ListViewport {
		t.Fatalf("visible rows = %d, want %d\n%s", listRowCount(body), tui.ListViewport, body)
	}
	if strings.Contains(body, "Golf") || strings.Contains(body, "Hotel") {
		t.Fatalf("rows beyond viewport leaked:\n%s", body)
	}
	m = apply(m, "down", "down", "down", "down", "down", "down")
	body = m.View().Content
	if !strings.Contains(body, "Golf") {
		t.Fatalf("cursor past last visible row must scroll:\n%s", body)
	}
	if listRowCount(body) != tui.ListViewport {
		t.Fatalf("scrolled rows = %d\n%s", listRowCount(body), body)
	}
	m = apply(m, "down", "down")
	if m.cursor != 0 {
		t.Fatalf("wrap-around cursor = %d, want 0", m.cursor)
	}
}

func TestPickerDoesNotRenderPluginNameOrRetitle(t *testing.T) {
	m := New(Options{
		Entries: eightEntries()[:2],
		Width:   62,
	})
	_ = m.Init()
	body := m.View().Content
	if strings.Contains(body, "herdr-workflows") {
		t.Fatalf("plugin name in body:\n%s", body)
	}
}

func TestPickerFilterAndPaletteRestore(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80})
	m = apply(m, "l", "o", "y")
	if m.filter != "loy" {
		t.Fatalf("filter = %q", m.filter)
	}
	body := m.View().Content
	if got := visibleLine(strings.Split(body, "\n")[1]); got != "loy" {
		t.Fatalf("filter row = %q", got)
	}
	if !strings.Contains(body, "Deploy") || strings.Contains(body, "Chat handoff") {
		t.Fatalf("filter miss:\n%s", body)
	}
	m = apply(m, "ctrl+p")
	if m.mode != modePalette {
		t.Fatalf("mode = %v", m.mode)
	}
	if !strings.Contains(m.View().Content, "letter fires") && !strings.Contains(m.View().Content, "Create new") {
		t.Fatalf("palette body:\n%s", m.View().Content)
	}
	m = apply(m, "esc")
	if m.mode != modeList || m.filter != "loy" {
		t.Fatalf("restore mode=%v filter=%q", m.mode, m.filter)
	}
}

func TestPrepareChdirsToRepoRoot(t *testing.T) {
	var seen string
	_, err := Prepare(Options{
		RepoRoot: "/managed/checkout",
		Chdir: func(path string) error {
			seen = path
			return errStop
		},
	})
	if seen != "/managed/checkout" {
		t.Fatalf("chdir = %q", seen)
	}
	if err != errStop {
		t.Fatalf("err = %v", err)
	}
}

func TestCustomChoiceInputAdvances(t *testing.T) {
	entry := workflow.ListEntry{Name: "place", Source: "global", File: "/global/place.yaml"}
	m := New(Options{
		Entries: []workflow.ListEntry{entry},
		Width:   80,
		Config:  config.Config{Profiles: map[string]config.Profile{}, Transcripts: map[string]config.TranscriptExtractor{}},
		LoadWorkflow: func(e workflow.ListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format,
				Inputs: []workflow.InputSpec{
					{Name: "unit", Type: "choice", Options: []string{"new"}, AllowCustom: true},
					{Name: "placement", Type: "choice", Options: []string{"tab", "below"}},
				},
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
	})
	m = apply(m, "enter")
	if m.mode != modeInput {
		t.Fatalf("mode after enter = %v status=%q", m.mode, m.status)
	}
	m.filter = "mytest"
	m = apply(m, "down") // custom row is last of 2
	m = apply(m, "enter")
	if m.mode != modeInputText || m.promptValue != "mytest" {
		t.Fatalf("custom field mode=%v value=%q", m.mode, m.promptValue)
	}
	m = apply(m, "enter")
	if m.session == nil || m.session.Values()["unit"] != "mytest" {
		t.Fatalf("values = %#v", m.session.Values())
	}
	if m.mode != modeInput {
		t.Fatalf("should advance to next choice, mode=%v", m.mode)
	}
}

func TestInputFailureScreen(t *testing.T) {
	entry := workflow.ListEntry{Name: "place", Source: "global", File: "/g.yaml"}
	m := New(Options{
		Entries: []workflow.ListEntry{entry},
		Width:   80,
		Config:  config.Config{Profiles: map[string]config.Profile{}, Transcripts: map[string]config.TranscriptExtractor{}},
		LoadWorkflow: func(e workflow.ListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format,
				Inputs: []workflow.InputSpec{
					{Name: "unit", Type: "choice", Options: []string{"a", "b"}},
					{Name: "prof", Type: "profile"},
				},
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
	})
	m = apply(m, "enter", "enter")
	if !strings.Contains(m.status, "no profiles configured") {
		t.Fatalf("status = %q", m.status)
	}
	if m.mode != modeFail {
		t.Fatalf("mode = %v", m.mode)
	}
	body := m.View().Content
	if strings.Contains(body, tui.ChoiceHint) && m.mode == modeInput {
		t.Fatal("stale choice list")
	}
}

func TestListFilterMissKeepsFilterRow(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80})
	if got := tui.StripContentPadding(strings.Split(m.View().Content, "\n")[1]); got != tui.FilterWorkflows {
		t.Fatalf("empty filter row = %q", got)
	}
	m = apply(m, "z", "z", "z")
	body := m.View().Content
	if got := tui.StripContentPadding(strings.Split(body, "\n")[1]); got != "zzz" {
		t.Fatalf("miss filter row = %q", got)
	}
	if !strings.Contains(body, "No workflows matching zzz") {
		t.Fatalf("miss copy:\n%s", body)
	}
	if strings.Contains(body, tui.EmptyCatalogMessage) {
		t.Fatal("reused empty-catalog copy")
	}
	empty := New(Options{Entries: nil, Width: 80})
	if strings.Contains(empty.View().Content, tui.FilterWorkflows) {
		t.Fatal("empty catalog must omit filter")
	}
}

func TestShowCurrentDoesNotBlockUpdate(t *testing.T) {
	root := t.TempDir()
	script := filepath.Join(root, "slow.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nsleep 30\necho one\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	entry := workflow.ListEntry{Name: "dyn", Source: "repo", File: filepath.Join(root, "w.yaml")}
	m := New(Options{
		Entries: []workflow.ListEntry{entry},
		Width:   80,
		LoadWorkflow: func(e workflow.ListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format,
				Inputs: []workflow.InputSpec{{
					Name: "branch", Type: "choice",
					DynamicOptions: &workflow.DynamicChoice{Run: []string{"sh", script}},
				}},
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
	})
	next, cmd := m.Update(press("enter"))
	m = next.(Model)
	if cmd == nil {
		t.Fatal("Current must run as a tea.Cmd")
	}
	done := make(chan tea.Msg, 1)
	go func() { done <- cmd() }()
	next, _ = m.Update(press("esc"))
	m = next.(Model)
	if m.mode != modeList {
		t.Fatalf("escape during resolve: mode=%v", m.mode)
	}
	select {
	case msg := <-done:
		resolved, ok := msg.(currentResolvedMsg)
		if !ok || !resolved.result.Cancelled {
			t.Fatalf("want cancelled, got %#v", msg)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Current did not return after CancelPending")
	}
}

func TestInputBackRestoresCollectedValue(t *testing.T) {
	entry := workflow.ListEntry{Name: "place", Source: "global", File: "/global/place.yaml"}
	m := New(Options{
		Entries: []workflow.ListEntry{entry},
		Width:   80,
		Config:  config.Config{Profiles: map[string]config.Profile{}, Transcripts: map[string]config.TranscriptExtractor{}},
		LoadWorkflow: func(e workflow.ListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format,
				Inputs: []workflow.InputSpec{
					{Name: "unit", Type: "choice", Options: []string{"new", "existing"}, AllowCustom: true},
					{Name: "placement", Type: "choice", Options: []string{"tab", "below"}},
				},
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
	})
	m = apply(m, "enter", "enter")
	if m.session.Values()["unit"] != "new" {
		t.Fatalf("values = %#v", m.session.Values())
	}
	m = apply(m, "esc")
	if m.mode != modeInput || m.choiceRows()[m.cursor] != "new" {
		t.Fatalf("restore choice mode=%v cursor=%q", m.mode, m.choiceRows()[m.cursor])
	}
	m.filter = "mine"
	m = apply(m, "down", "down", "enter")
	if m.mode != modeInputText || m.promptValue != "mine" {
		t.Fatalf("custom field mode=%v value=%q", m.mode, m.promptValue)
	}
	m = apply(m, "enter", "esc")
	if m.mode != modeInputText || m.promptValue != "mine" {
		t.Fatalf("restore custom mode=%v value=%q", m.mode, m.promptValue)
	}
}

func TestAcceptCurrentPresentsSensitivityNames(t *testing.T) {
	entry := workflow.ListEntry{
		Name: "deploy", Source: "global", File: "/g/deploy.yaml", Title: "Deploy",
		HasCommands: true, NeedsTranscript: true,
	}
	m := New(Options{
		Entries: []workflow.ListEntry{entry},
		Width:   80,
		LoadWorkflow: func(e workflow.ListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format, Title: "Deploy",
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
	})
	m = apply(m, "enter")
	if m.consent != "Deploy | global | commands | transcript" {
		t.Fatalf("consent = %q", m.consent)
	}
	body := m.View().Content
	if !strings.Contains(body, "commands") || !strings.Contains(body, "transcript") {
		t.Fatalf("flag names missing:\n%s", body)
	}
}

func TestConfirmedDeleteRemovesFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "deploy.yaml")
	if err := os.WriteFile(path, []byte("name: deploy\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	keep := workflow.ListEntry{Name: "keep", Source: "repo", File: filepath.Join(dir, "keep.yaml"), Title: "Keep"}
	entry := workflow.ListEntry{Name: "deploy", Source: "repo", File: path, Title: "Deploy"}
	m := New(Options{Entries: []workflow.ListEntry{entry, keep}, Width: 80})
	m = apply(m, "ctrl+p", "d", "y")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("file remained: %v", err)
	}
	if len(m.entries) != 1 || m.entries[0].Name != "keep" {
		t.Fatalf("entries = %#v", m.entries)
	}
	if m.mode != modeList || !m.delete.DeleteInFlight {
		t.Fatalf("mode=%v inFlight=%v", m.mode, m.delete.DeleteInFlight)
	}
}

type stopErr struct{}

func (stopErr) Error() string { return "stop-after-chdir" }

var errStop stopErr

func TestPickerViewportGrowsWithPopupHeight(t *testing.T) {
	// Rows fill the popup above the six-row minimum.
	m := New(Options{Entries: eightEntries(), Width: 62, Height: 30})
	body := m.View().Content
	for _, name := range []string{"Golf", "Hotel"} {
		if !strings.Contains(body, name) {
			t.Fatalf("tall popup must show %s without scrolling:\n%s", name, body)
		}
	}
	short := New(Options{Entries: eightEntries(), Width: 62, Height: 14})
	if strings.Contains(short.View().Content, "Golf") {
		t.Fatalf("short popup must keep the six-row floor:\n%s", short.View().Content)
	}
}

func TestPaletteBodyUsesSharedRowChrome(t *testing.T) {
	// The palette shows with the list chrome.
	m := New(Options{Entries: eightEntries(), Width: 62, Height: 24})
	m = applyMsg(m, tea.KeyPressMsg{Code: 'p', Mod: tea.ModCtrl})
	if m.mode != modePalette {
		t.Fatalf("mode = %v, want palette", m.mode)
	}
	body := m.View().Content
	plain := ansi.Strip(body)
	if !strings.Contains(plain, "   n  new") {
		t.Fatalf("palette rows must use the shared row indent:\n%s", plain)
	}
	if !strings.Contains(plain, "----") {
		t.Fatalf("palette must draw the rule:\n%s", plain)
	}
	if !strings.Contains(plain, tui.PaletteHint) {
		t.Fatalf("palette must keep its footer hint:\n%s", plain)
	}
	if !strings.Contains(body, "\x1b[") {
		t.Fatalf("palette must paint through the theme:\n%q", body)
	}
}
