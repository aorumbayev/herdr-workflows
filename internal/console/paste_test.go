package console

import (
	"strconv"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func consoleModel(t *testing.T) Model {
	t.Helper()
	return New(Options{
		Entries: []workflow.ListEntry{
			{Name: "alpha", Title: "Alpha", Source: "repo"},
			{Name: "beta", Title: "Beta", Source: "repo"},
		},
		Width:  80,
		Height: 24,
	})
}

func TestPasteMsgAppendsToActiveField(t *testing.T) {
	next, _ := consoleModel(t).Update(tea.PasteMsg{Content: "bet"})
	if got := next.(Model).wfFilter; got != "bet" {
		t.Fatalf("workflows filter = %q", got)
	}
	m := consoleModel(t)
	m.screen = screenRuns
	next, _ = m.Update(tea.PasteMsg{Content: "run"})
	if got := next.(Model).runFilter; got != "run" {
		t.Fatalf("runs filter = %q", got)
	}
}

func TestPasteFlattensMultilineClipboard(t *testing.T) {
	m := consoleModel(t)
	m.screen = screenDiagram
	m.diagramMode = diagramModeInstruction
	next, _ := m.Update(tea.PasteMsg{Content: "step one\nstep two"})
	if got := next.(Model).instructionDraft; got != "step one step two" {
		t.Fatalf("composer draft = %q", got)
	}
}

func TestOversizedPasteRefusedAndReported(t *testing.T) {
	next, _ := consoleModel(t).Update(tea.PasteMsg{Content: strings.Repeat("x", caps.FieldPasteByteLimit+1)})
	m := next.(Model)
	if m.wfFilter != "" {
		t.Fatalf("oversized paste must leave the field untouched, got %q", m.wfFilter)
	}
	if !strings.Contains(m.status, strconv.Itoa(caps.FieldPasteByteLimit)) {
		t.Fatalf("status must name the limit, got %q", m.status)
	}
}

func TestCtrlVReadsClipboard(t *testing.T) {
	m := consoleModel(t)
	m.pasteText = func() (string, error) { return "from-clipboard\n", nil }
	next, _ := m.Update(tea.KeyPressMsg{Code: 'v', Mod: tea.ModCtrl})
	if got := next.(Model).wfFilter; got != "from-clipboard" {
		t.Fatalf("ctrl+v filter = %q", got)
	}
}
