package picker

import (
	"strconv"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

func TestPasteMsgAppendsToActiveField(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80})
	m = applyMsg(m, tea.PasteMsg{Content: "deploy"})
	if m.filter != "deploy" {
		t.Fatalf("list filter = %q", m.filter)
	}
	m2 := New(Options{Width: 60, Height: 24})
	m2.mode = modeNewName
	m2 = applyMsg(m2, tea.PasteMsg{Content: "my-deploy"})
	if m2.promptValue != "my-deploy" {
		t.Fatalf("new name = %q", m2.promptValue)
	}
}

func TestPasteFlattensMultilineClipboard(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80})
	m = applyMsg(m, tea.PasteMsg{Content: "line one\r\nline two\tline three"})
	if m.filter != "line one line two line three" {
		t.Fatalf("filter = %q", m.filter)
	}
}

func TestOversizedPasteRefusedAndReported(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80})
	m = applyMsg(m, tea.PasteMsg{Content: strings.Repeat("x", caps.FieldPasteByteLimit+1)})
	if m.filter != "" {
		t.Fatalf("oversized paste must leave the field untouched, got %q", m.filter)
	}
	if !strings.Contains(m.status, strconv.Itoa(caps.FieldPasteByteLimit)) {
		t.Fatalf("status must name the limit, got %q", m.status)
	}
}

func TestCtrlVReadsClipboard(t *testing.T) {
	m := New(Options{
		Entries:        catalogEntries(),
		Width:          80,
		PasteClipboard: func() (string, error) { return "from-clipboard\n", nil },
	})
	m = apply(m, "ctrl+v")
	if m.filter != "from-clipboard" {
		t.Fatalf("ctrl+v filter = %q", m.filter)
	}
}

func TestCtrlVSurvivesStdinLeakFilter(t *testing.T) {
	if ShouldDropStdinLeakSequence("\x16") {
		t.Fatal("ctrl+v must reach the field handlers")
	}
	msg := FilterInput(nil, tea.KeyPressMsg{Code: 'v', Mod: tea.ModCtrl})
	if msg == nil {
		t.Fatal("FilterInput dropped ctrl+v")
	}
}

func TestPasteReachesTheEmbeddedRunsBrowser(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80, RepoRoot: t.TempDir()})
	m = apply(m, "tab")
	m = applyMsg(m, tea.PasteMsg{Content: "dep"})
	if !strings.Contains(m.View().Content, tui.FieldCursor+"  dep") {
		t.Fatalf("runs tab paste missing:\n%s", m.View().Content)
	}
}
