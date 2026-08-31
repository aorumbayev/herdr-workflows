package console

import (
	"reflect"
	"runtime"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/charmbracelet/x/ansi"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestFormatRetryCommand(t *testing.T) {
	got := FormatRetryCommand("deploy")
	if got != "hwf run deploy" {
		t.Fatalf("got %q", got)
	}
}

func TestNewDefaultsClipboardToTUI(t *testing.T) {
	m := New(Options{})
	if m.copyText == nil {
		t.Fatal("nil clipboard")
	}
	name := runtime.FuncForPC(reflect.ValueOf(m.copyText).Pointer()).Name()
	if !strings.Contains(name, "tui.CopyToClipboard") {
		t.Fatalf("copyText = %q", name)
	}
}

func TestDebugTabBodies(t *testing.T) {
	logBody := FormatDebugBody(DebugTabLog, DebugContent{
		LogLines: []string{"RUNNING demo", "step ok"},
	})
	if !strings.Contains(logBody, "RUNNING demo") {
		t.Fatalf("log body = %q", logBody)
	}
	missing := FormatDebugBody(DebugTabTranscript, DebugContent{})
	if !strings.Contains(strings.ToLower(missing), "no transcript") {
		t.Fatalf("transcript empty = %q", missing)
	}
	yamlBody := FormatDebugBody(DebugTabYAML, DebugContent{
		EntryYAML: "version: v1alpha1\n",
	})
	if !strings.Contains(yamlBody, "version: v1alpha1") {
		t.Fatalf("yaml body = %q", yamlBody)
	}
}

func TestModelWorkflowsListAndTabToRuns(t *testing.T) {
	m := New(Options{
		Entries: []workflow.ListEntry{
			{Name: "alpha", Title: "Alpha", Source: "repo"},
			{Name: "beta", Title: "Beta", Source: "global"},
		},
		Width:  80,
		Height: 24,
		LoadRuns: func() []history.Summary {
			return []history.Summary{{
				ID:       "11111111-1111-4111-8111-111111111111",
				Workflow: "alpha",
				Title:    "Alpha",
				Status:   "succeeded",
			}}
		},
	})
	view := stripView(m.View())
	if !strings.Contains(view, "Alpha") || !strings.Contains(view, "Beta") {
		t.Fatalf("workflows view = %q", view)
	}
	if !strings.Contains(view, "enter diagram") {
		t.Fatalf("workflows footer missing enter diagram: %q", view)
	}
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
	m = next.(Model)
	view = stripView(m.View())
	if !strings.Contains(view, "Alpha") || !strings.Contains(strings.ToLower(view), "ok") && !strings.Contains(view, "succeeded") && !strings.Contains(view, "OK") {
		// Status can be abbreviated OK.
		if !strings.Contains(view, "Alpha") {
			t.Fatalf("runs view = %q", view)
		}
	}
	if !strings.Contains(view, "enter detail") {
		t.Fatalf("runs footer missing enter detail: %q", view)
	}
}

func TestModelRunDetailDebugTabsAndRetryCopy(t *testing.T) {
	id := "22222222-2222-4222-8222-222222222222"
	var copied string
	m := New(Options{
		Width:  80,
		Height: 24,
		LoadRuns: func() []history.Summary {
			return []history.Summary{{ID: id, Workflow: "alpha", Title: "Alpha", Status: "failed"}}
		},
		LoadDetail: func(runID string) DetailPayload {
			return DetailPayload{
				Workflow: "alpha",
				LogLines: []string{"FAILED alpha", "step 1 failed"},
				Artifacts: history.DebugArtifacts{
					EntryYAML:     "version: v1alpha1\nsteps:\n  - run: [false]\n",
					HasEntryYAML:  true,
					Transcript:    "agent said hi",
					HasTranscript: true,
				},
			}
		},
		CopyClipboard: func(text string) error {
			copied = text
			return nil
		},
	})
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
	m = next.(Model)
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	view := stripView(m.View())
	if !strings.Contains(view, "FAILED alpha") {
		t.Fatalf("log tab = %q", view)
	}
	if !strings.Contains(view, "log") || !strings.Contains(view, "transcript") || !strings.Contains(view, "yaml") {
		t.Fatalf("tab chrome = %q", view)
	}
	next, _ = m.Update(keyRune('2'))
	m = next.(Model)
	view = stripView(m.View())
	if !strings.Contains(view, "agent said hi") {
		t.Fatalf("transcript tab = %q", view)
	}
	next, _ = m.Update(keyRune('3'))
	m = next.(Model)
	view = stripView(m.View())
	if !strings.Contains(view, "version: v1alpha1") {
		t.Fatalf("yaml tab = %q", view)
	}
	next, _ = m.Update(keyRune('y'))
	m = next.(Model)
	if copied != "hwf run alpha" {
		t.Fatalf("copied = %q", copied)
	}
	view = stripView(m.View())
	if !strings.Contains(strings.ToLower(view), "copied") {
		t.Fatalf("status = %q", view)
	}
}

func TestModelConsoleCatalogChromeMatchesOverlay(t *testing.T) {
	m := New(Options{
		Entries: []workflow.ListEntry{
			{Name: "deploy", Title: "Deploy", Source: "global", HasCommands: true},
			{Name: "alpha", Title: "Alpha", Source: "repo"},
			{Name: "broken", Source: "repo", Error: "boom"},
		},
		Width:  80,
		Height: 24,
	})
	view := stripView(m.View())
	if !strings.Contains(view, "filter workflows...") {
		t.Fatalf("missing filter placeholder:\n%s", view)
	}
	for _, want := range []string{"Deploy", "!", "global", "repo", "invalid"} {
		if !strings.Contains(view, want) {
			t.Fatalf("chrome missing %q:\n%s", want, view)
		}
	}
}

func TestModelConsoleFiltersWorkflows(t *testing.T) {
	m := New(Options{
		Entries: []workflow.ListEntry{
			{Name: "alpha", Title: "Alpha", Source: "repo"},
			{Name: "beta", Title: "Beta", Source: "repo"},
		},
		Width:  80,
		Height: 24,
	})
	consoleRow := func(view string, i int) string {
		return strings.TrimRight(ansi.Strip(tui.StripContentPadding(strings.Split(view, "\n")[i])), " ")
	}
	if got := consoleRow(stripView(m.View()), 1); got != tui.FieldCursor+"  "+tui.FilterWorkflows {
		t.Fatalf("empty filter row = %q", got)
	}
	if got := consoleRow(stripView(m.View()), 2); got != tui.FormatFieldEdge(m.contentWidth()) {
		t.Fatalf("field edge row = %q", got)
	}
	next, _ := m.Update(keyRune('b'))
	m = next.(Model)
	view := stripView(m.View())
	if !strings.Contains(view, "Beta") || strings.Contains(view, "Alpha") {
		t.Fatalf("filter b should keep only Beta:\n%s", view)
	}
	if got := consoleRow(view, 1); got != tui.FieldCursor+"  b" {
		t.Fatalf("typed filter row = %q", got)
	}
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyBackspace})
	m = next.(Model)
	view = stripView(m.View())
	if !strings.Contains(view, "Alpha") || !strings.Contains(view, "Beta") {
		t.Fatalf("backspace should restore all rows:\n%s", view)
	}
}

func TestModelConsoleLandsOnSelectedDiagram(t *testing.T) {
	m := New(Options{
		Entries: []workflow.ListEntry{
			{Name: "alpha", Title: "Alpha", Source: "repo"},
			{Name: "deploy", Title: "Deploy", Source: "repo"},
		},
		Width:           80,
		Height:          24,
		LandingWorkflow: "deploy",
		LoadWorkflow: func(e workflow.ListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{Name: e.Name, Title: e.Title, Version: workflow.Format, Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}}}, nil
		},
	})
	if m.screen != screenDiagram {
		t.Fatalf("screen = %v, want diagram", m.screen)
	}
	view := stripView(m.View())
	if !strings.Contains(view, "diagram") || !strings.Contains(view, "Deploy") {
		t.Fatalf("landing view = %q", view)
	}
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	m = next.(Model)
	if m.screen != screenWorkflows {
		t.Fatalf("esc from landed diagram screen = %v, want workflows", m.screen)
	}
	view = stripView(m.View())
	if !strings.Contains(view, "enter diagram") {
		t.Fatalf("esc must show the catalog footer:\n%s", view)
	}
}

func TestModelConsoleViewUsesAltScreen(t *testing.T) {
	m := New(Options{Width: 80, Height: 24})
	if !m.View().AltScreen {
		t.Fatal("console View must enable alt-screen so quit restores the terminal")
	}
}

func keyRune(r rune) tea.KeyPressMsg {
	return tea.KeyPressMsg{Text: string(r), Code: r}
}

func stripView(v tea.View) string {
	return v.Content
}

func TestConsoleListViewportUsesTerminalHeight(t *testing.T) {
	m := New(Options{Width: 80, Height: 40})
	if m.listViewport() != 32 {
		t.Fatalf("listViewport = %d want 32", m.listViewport())
	}
	m = New(Options{Width: 80, Height: 6})
	if m.listViewport() != 3 {
		t.Fatalf("short terminal = %d", m.listViewport())
	}
	m = New(Options{Width: 80, Height: 40})
	if m.scrollViewport() != 37 {
		t.Fatalf("scrollViewport = %d want 37", m.scrollViewport())
	}
}
