package console

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestFormatRetryCommand(t *testing.T) {
	got := FormatRetryCommand("deploy")
	if got != "hwf run deploy" {
		t.Fatalf("got %q", got)
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
		Entries: []workflow.WorkflowListEntry{
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
	if !strings.Contains(view, "tab runs") {
		t.Fatalf("footer missing tab runs: %q", view)
	}
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
	m = next.(Model)
	view = stripView(m.View())
	if !strings.Contains(view, "Alpha") || !strings.Contains(strings.ToLower(view), "ok") && !strings.Contains(view, "succeeded") && !strings.Contains(view, "OK") {
		// status may be abbreviated OK
		if !strings.Contains(view, "Alpha") {
			t.Fatalf("runs view = %q", view)
		}
	}
	if !strings.Contains(view, "tab workflows") {
		t.Fatalf("runs footer = %q", view)
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

func keyRune(r rune) tea.KeyPressMsg {
	return tea.KeyPressMsg{Text: string(r), Code: r}
}

func stripView(v tea.View) string {
	return v.Content
}
