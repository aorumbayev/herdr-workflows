package console

import (
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/history"
)

func consoleWithRuns(t *testing.T, now *time.Time, runs ...history.Summary) (Model, tea.Cmd) {
	t.Helper()
	m := New(Options{
		Width:    80,
		Height:   24,
		LoadRuns: func() []history.Summary { return runs },
		Now:      func() time.Time { return *now },
	})
	next, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
	return next.(Model), cmd
}

func runningSummary(started time.Time) history.Summary {
	return history.Summary{
		ID:        "11111111-1111-4111-8111-111111111111",
		DisplayID: "11111111",
		Workflow:  "live",
		Status:    "running",
		StartedAt: started.Format("2006-01-02T15:04:05.000Z"),
	}
}

func TestConsoleRunningRunElapsedTicksInView(t *testing.T) {
	started := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	now := started.Add(2 * time.Second)
	m, cmd := consoleWithRuns(t, &now, runningSummary(started))
	if cmd == nil {
		t.Fatal("running run must arm the console runs ticker")
	}
	first := m.View().Content
	if !strings.Contains(first, "2s") {
		t.Fatalf("view missing 2s elapsed:\n%s", first)
	}
	now = started.Add(5 * time.Second)
	second := m.View().Content
	if !strings.Contains(second, "5s") {
		t.Fatalf("view missing advanced 5s elapsed:\n%s", second)
	}
	if first == second {
		t.Fatal("elapsed did not advance across ticks")
	}
}

func TestConsoleRunsTickStopsForTerminalRuns(t *testing.T) {
	started := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	now := started.Add(2 * time.Second)
	terminal := runningSummary(started)
	terminal.Status = "succeeded"
	terminal.FinishedAt = started.Add(3 * time.Second).Format("2006-01-02T15:04:05.000Z")
	terminal.ElapsedMs = 3000
	m, cmd := consoleWithRuns(t, &now, terminal)
	if cmd != nil {
		t.Fatal("terminal-only runs must not arm the ticker")
	}
	if m.runsTicking {
		t.Fatal("ticking flag must stay clear for terminal runs")
	}
	now = started.Add(9000 * time.Second)
	if !strings.Contains(m.View().Content, "3s") {
		t.Fatalf("terminal elapsed must stay frozen at 3s:\n%s", m.View().Content)
	}
}

func TestConsoleRunsTickIgnoresStaleEpoch(t *testing.T) {
	started := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	now := started.Add(time.Second)
	m, _ := consoleWithRuns(t, &now, runningSummary(started))
	if m.runsEpoch == 0 {
		t.Fatal("runs screen did not arm a tick epoch")
	}
	_, cmd := m.Update(runsTickMsg{epoch: m.runsEpoch - 1})
	if cmd != nil {
		t.Fatal("a stale-epoch tick must not re-arm")
	}
	_, cmd = m.Update(runsTickMsg{epoch: m.runsEpoch})
	if cmd == nil {
		t.Fatal("a current-epoch tick must re-arm while a run is active")
	}
}
