package picker

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func eightEntries() []workflow.WorkflowListEntry {
	names := []string{"alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"}
	out := make([]workflow.WorkflowListEntry, len(names))
	for i, name := range names {
		out[i] = workflow.WorkflowListEntry{Name: name, Source: "repo", File: "/r/" + name + ".yaml", Title: strings.ToUpper(name[:1]) + name[1:]}
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
	case "ctrl+k":
		return tea.KeyPressMsg{Code: 'k', Mod: tea.ModCtrl}
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

func listRowCount(view string) int {
	n := 0
	for _, line := range strings.Split(view, "\n") {
		if strings.HasPrefix(line, "> ") || strings.HasPrefix(line, "  ") && (strings.Contains(line, "repo") || strings.Contains(line, "global") || strings.Contains(line, "invalid")) {
			if strings.HasPrefix(strings.TrimLeft(line, " "), "-") {
				continue
			}
			n++
		}
	}
	return n
}

func TestPickerViewportShowsSixRowsAndScrolls(t *testing.T) {
	// Ports picker-presentation: six-row viewport, scroll to keep cursor visible, wrap-around.
	m := New(Options{Entries: eightEntries(), Width: 62})
	body := m.View().Content
	if listRowCount(body) != ListViewport {
		t.Fatalf("visible rows = %d, want %d\n%s", listRowCount(body), ListViewport, body)
	}
	if strings.Contains(body, "Golf") || strings.Contains(body, "Hotel") {
		t.Fatalf("rows beyond viewport leaked:\n%s", body)
	}
	m = apply(m, "down", "down", "down", "down", "down", "down")
	body = m.View().Content
	if !strings.Contains(body, "Golf") {
		t.Fatalf("cursor past last visible row must scroll:\n%s", body)
	}
	if listRowCount(body) != ListViewport {
		t.Fatalf("scrolled rows = %d\n%s", listRowCount(body), body)
	}
	m = apply(m, "down", "down")
	if m.cursor != 0 {
		t.Fatalf("wrap-around cursor = %d, want 0", m.cursor)
	}
}

func TestPickerDoesNotRenderPluginNameOrRetitle(t *testing.T) {
	var metadata int
	m := New(Options{
		Entries:            eightEntries()[:2],
		Width:              62,
		ReportPaneMetadata: func() { metadata++ },
	})
	_ = m.Init()
	body := m.View().Content
	if strings.Contains(body, "herdr-workflows") {
		t.Fatalf("plugin name in body:\n%s", body)
	}
	if metadata != 0 {
		t.Fatal("pane.report_metadata must not run")
	}
}

func TestPickerFilterAndPaletteRestore(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80})
	m = apply(m, "d", "e", "p")
	if m.filter != "dep" {
		t.Fatalf("filter = %q", m.filter)
	}
	body := m.View().Content
	if got := strings.Split(body, "\n")[0]; got != "dep" {
		t.Fatalf("filter row = %q", got)
	}
	if !strings.Contains(body, "Deploy") || strings.Contains(body, "Chat handoff") {
		t.Fatalf("filter miss:\n%s", body)
	}
	m = apply(m, "ctrl+k")
	if m.mode != modePalette {
		t.Fatalf("mode = %v", m.mode)
	}
	if !strings.Contains(m.View().Content, "letter fires") && !strings.Contains(m.View().Content, "Create new") {
		t.Fatalf("palette body:\n%s", m.View().Content)
	}
	m = apply(m, "esc")
	if m.mode != modeList || m.filter != "dep" {
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
	entry := workflow.WorkflowListEntry{Name: "place", Source: "global", File: "/global/place.yaml"}
	m := New(Options{
		Entries: []workflow.WorkflowListEntry{entry},
		Width:   80,
		Config:  config.Config{Profiles: map[string]config.Profile{}, Transcripts: map[string]config.TranscriptExtractor{}},
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
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
	entry := workflow.WorkflowListEntry{Name: "place", Source: "global", File: "/g.yaml"}
	m := New(Options{
		Entries: []workflow.WorkflowListEntry{entry},
		Width:   80,
		Config:  config.Config{Profiles: map[string]config.Profile{}, Transcripts: map[string]config.TranscriptExtractor{}},
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
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
	if got := strings.Split(m.View().Content, "\n")[0]; got != tui.FilterWorkflows {
		t.Fatalf("empty filter row = %q", got)
	}
	m = apply(m, "z", "z", "z")
	body := m.View().Content
	if got := strings.Split(body, "\n")[0]; got != "zzz" {
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
	entry := workflow.WorkflowListEntry{Name: "dyn", Source: "repo", File: filepath.Join(root, "w.yaml")}
	m := New(Options{
		Entries: []workflow.WorkflowListEntry{entry},
		Width:   80,
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
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
	time.Sleep(20 * time.Millisecond)
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
	entry := workflow.WorkflowListEntry{Name: "place", Source: "global", File: "/global/place.yaml"}
	m := New(Options{
		Entries: []workflow.WorkflowListEntry{entry},
		Width:   80,
		Config:  config.Config{Profiles: map[string]config.Profile{}, Transcripts: map[string]config.TranscriptExtractor{}},
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
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
	entry := workflow.WorkflowListEntry{
		Name: "deploy", Source: "global", File: "/g/deploy.yaml", Title: "Deploy",
		HasCommands: true, NeedsTranscript: true,
	}
	m := New(Options{
		Entries: []workflow.WorkflowListEntry{entry},
		Width:   80,
		LoadWorkflow: func(e workflow.WorkflowListEntry) (*workflow.Definition, error) {
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
	keep := workflow.WorkflowListEntry{Name: "keep", Source: "repo", File: filepath.Join(dir, "keep.yaml"), Title: "Keep"}
	entry := workflow.WorkflowListEntry{Name: "deploy", Source: "repo", File: path, Title: "Deploy"}
	m := New(Options{Entries: []workflow.WorkflowListEntry{entry, keep}, Width: 80})
	m = apply(m, "ctrl+k", "d", "y")
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
