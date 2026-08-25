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
	w := claimRunningRun(t, getenv, checkout, workflow, startedAt)
	w.Dispose()
	return w.ID()
}

func claimRunningRun(t *testing.T, getenv config.Env, checkout, workflow, startedAt string) *history.Writer {
	t.Helper()
	w := history.NewWriter(getenv)
	t.Cleanup(w.Dispose)
	meta := history.ClaimMeta{Workflow: workflow, Source: "repo", CheckoutRoot: checkout}
	if startedAt != "" {
		meta.StartedAt = startedAt
	}
	result := w.Claim(meta)
	if !result.OK || result.State != "claimed" {
		t.Fatalf("claim = %+v", result)
	}
	return w
}

func applyImmediateCmd(t *testing.T, m Model, cmd tea.Cmd) (Model, tea.Cmd) {
	t.Helper()
	if cmd == nil {
		return m, nil
	}
	done := make(chan tea.Msg, 1)
	go func() { done <- cmd() }()
	select {
	case msg := <-done:
		if msg == nil {
			return m, nil
		}
		next, follow := m.Update(msg)
		return next.(Model), follow
	case <-time.After(300 * time.Millisecond):
		t.Fatal("tick must reload runs immediately, not wait for the 1s interval")
	}
	return m, nil
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
	started := time.Now().UTC().Add(-3 * time.Second)
	startISO := started.Format("2006-01-02T15:04:05.000Z")
	w := claimRunningRun(t, getenv, checkout, "live", startISO)

	var now time.Time
	m := New(Options{RepoRoot: checkout, Width: 80, Env: getenv, Now: func() time.Time { return now }})
	now = started.Add(2 * time.Second)
	m, _ = loadListOnce(t, m)
	if !m.ticking {
		t.Fatal("running run must arm the ticker")
	}
	w.Finalize("succeeded", history.FinalizeOpts{})

	next, cmd := m.Update(tickMsg{epoch: m.tickEpoch})
	m = next.(Model)
	m, follow := applyImmediateCmd(t, m, cmd)
	if follow != nil {
		t.Fatal("ticker must not re-arm once the reloaded snapshot is terminal")
	}
	if m.ticking {
		t.Fatal("ticking flag must clear when nothing runs")
	}
	if len(m.state.Items) != 1 || !history.IsTerminal(m.state.Items[0].Status) {
		t.Fatalf("reloaded run must be terminal, got %+v", m.state.Items)
	}
	frozen := history.FormatElapsed(m.state.Items[0].ElapsedMs)
	if frozen == "" || frozen == "0s" && m.state.Items[0].ElapsedMs != 0 {
		t.Fatalf("recorded elapsed missing: %+v", m.state.Items[0])
	}
	if !strings.Contains(m.View().Content, frozen) {
		t.Fatalf("view missing recorded elapsed %q:\n%s", frozen, m.View().Content)
	}
	now = started.Add(time.Hour)
	if climbing := history.FormatElapsed(history.LiveElapsedMs(history.Summary{
		Status:    "running",
		StartedAt: startISO,
	}, now)); strings.Contains(m.View().Content, climbing) && climbing != frozen {
		t.Fatalf("elapsed kept climbing after finish (%q) view:\n%s", climbing, m.View().Content)
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
	next, cmd := m.Update(tickMsg{epoch: m.tickEpoch})
	m = next.(Model)
	if cmd == nil {
		t.Fatal("a current-epoch tick must reload while a run is active")
	}
	_, follow := applyImmediateCmd(t, m, cmd)
	if follow == nil {
		t.Fatal("a current-epoch tick must re-arm after reload while a run is active")
	}
}
