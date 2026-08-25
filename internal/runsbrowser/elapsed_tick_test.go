package runsbrowser

import (
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/history"
)

func writeRunningRun(t *testing.T, getenv config.Env, checkout, workflow, startedAt string) string {
	t.Helper()
	w := history.NewWriter(getenv)
	meta := history.ClaimMeta{Workflow: workflow, Source: "repo", CheckoutRoot: checkout}
	if startedAt != "" {
		meta.StartedAt = startedAt
	}
	result := w.Claim(meta)
	if !result.OK || result.State != "claimed" {
		t.Fatalf("claim = %+v", result)
	}
	w.Dispose()
	return w.ID()
}

func loadListOnce(t *testing.T, m Model) (Model, tea.Cmd) {
	t.Helper()
	cmd := m.Init()
	if cmd == nil {
		return m, nil
	}
	msg := cmd()
	if msg == nil {
		return m, nil
	}
	next, follow := m.Update(msg)
	return next.(Model), follow
}

func TestRunningRunElapsedTicksInView(t *testing.T) {
	stateDir := t.TempDir()
	checkout := t.TempDir()
	getenv := testGetenv(t, stateDir)
	started := time.Now().UTC()
	startISO := started.Format("2006-01-02T15:04:05.000Z")
	writeRunningRun(t, getenv, checkout, "live", startISO)

	var now time.Time
	m := New(Options{RepoRoot: checkout, Width: 80, Env: getenv, Now: func() time.Time { return now }})
	now = started.Add(2 * time.Second)
	m, follow := loadListOnce(t, m)
	if follow == nil {
		t.Fatal("a running run must arm the ticker")
	}
	if len(m.state.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(m.state.Items))
	}
	if history.IsTerminal(m.state.Items[0].Status) {
		t.Fatalf("run must be non-terminal, got %q", m.state.Items[0].Status)
	}
	want1 := history.FormatElapsed(history.LiveElapsedMs(m.state.Items[0], now))
	if !strings.Contains(m.View().Content, want1) {
		t.Fatalf("view missing elapsed %q:\n%s", want1, m.View().Content)
	}
	now = started.Add(5 * time.Second)
	want2 := history.FormatElapsed(history.LiveElapsedMs(m.state.Items[0], now))
	if want2 == want1 {
		t.Fatalf("elapsed token did not advance across ticks: %q", want2)
	}
	if !strings.Contains(m.View().Content, want2) {
		t.Fatalf("view missing advanced elapsed %q:\n%s", want2, m.View().Content)
	}
}

func TestRunsTickArmsForRunningStopsForTerminal(t *testing.T) {
	stateDir := t.TempDir()
	getenv := testGetenv(t, stateDir)
	now := time.Now().UTC()
	nowISO := now.Format("2006-01-02T15:04:05.000Z")

	running := t.TempDir()
	writeRunningRun(t, getenv, running, "live", nowISO)
	mr := New(Options{RepoRoot: running, Width: 80, Env: getenv})
	mr, follow := loadListOnce(t, mr)
	if follow == nil || !mr.ticking {
		t.Fatalf("running run must arm the ticker: follow=%v ticking=%v", follow != nil, mr.ticking)
	}

	terminal := t.TempDir()
	writeSucceededRun(t, getenv, terminal, "done", nowISO)
	mt := New(Options{RepoRoot: terminal, Width: 80, Env: getenv})
	mt, followTerm := loadListOnce(t, mt)
	if followTerm != nil || mt.ticking {
		t.Fatalf("terminal-only list must not arm the ticker: follow=%v ticking=%v", followTerm != nil, mt.ticking)
	}
}

func TestRunsTickStopsWhenRunFinishes(t *testing.T) {
	stateDir := t.TempDir()
	checkout := t.TempDir()
	getenv := testGetenv(t, stateDir)
	nowISO := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	writeRunningRun(t, getenv, checkout, "live", nowISO)

	m := New(Options{RepoRoot: checkout, Width: 80, Env: getenv})
	m, _ = loadListOnce(t, m)
	if !m.ticking {
		t.Fatal("running run must arm the ticker")
	}
	m.state.Items[0].Status = "succeeded"
	next, cmd := m.Update(tickMsg{epoch: m.tickEpoch})
	m = next.(Model)
	if cmd != nil {
		t.Fatal("ticker must not re-arm once no run is non-terminal")
	}
	if m.ticking {
		t.Fatal("ticking flag must clear when nothing runs")
	}
}

func TestRunsTickIgnoresStaleEpoch(t *testing.T) {
	stateDir := t.TempDir()
	checkout := t.TempDir()
	getenv := testGetenv(t, stateDir)
	nowISO := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	writeRunningRun(t, getenv, checkout, "live", nowISO)

	m := New(Options{RepoRoot: checkout, Width: 80, Env: getenv})
	m, _ = loadListOnce(t, m)
	if m.tickEpoch == 0 {
		t.Fatal("epoch must advance when the ticker arms")
	}
	_, cmd := m.Update(tickMsg{epoch: m.tickEpoch - 1})
	if cmd != nil {
		t.Fatal("a stale-epoch tick must not re-arm")
	}
	_, cmd = m.Update(tickMsg{epoch: m.tickEpoch})
	if cmd == nil {
		t.Fatal("a current-epoch tick must re-arm while a run is active")
	}
}
