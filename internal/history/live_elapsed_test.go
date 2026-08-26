package history

import (
	"testing"
	"time"
)

func TestLiveElapsedMsRunningGrowsWithNow(t *testing.T) {
	started := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	iso := started.Format("2006-01-02T15:04:05.000Z")
	run := Summary{Status: "running", StartedAt: iso, ElapsedMs: 0}
	first := LiveElapsedMs(run, started.Add(2*time.Second))
	second := LiveElapsedMs(run, started.Add(5*time.Second))
	if first != 2000 || second != 5000 {
		t.Fatalf("first=%d second=%d, want 2000 then 5000", first, second)
	}
	if second <= first {
		t.Fatalf("running elapsed must grow: first=%d second=%d", first, second)
	}
}

func TestLiveElapsedMsStaleUsesNow(t *testing.T) {
	started := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	iso := started.Format("2006-01-02T15:04:05.000Z")
	run := Summary{Status: "stale", StartedAt: iso, ElapsedMs: 0}
	if got := LiveElapsedMs(run, started.Add(30*time.Second)); got != 30000 {
		t.Fatalf("stale elapsed = %d, want 30000", got)
	}
}

func TestLiveElapsedMsTerminalStableAcrossNow(t *testing.T) {
	started := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	iso := started.Format("2006-01-02T15:04:05.000Z")
	finishedISO := started.Add(4 * time.Second).Format("2006-01-02T15:04:05.000Z")
	run := Summary{Status: "succeeded", StartedAt: iso, FinishedAt: finishedISO, ElapsedMs: 4000}
	first := LiveElapsedMs(run, started.Add(10*time.Second))
	second := LiveElapsedMs(run, started.Add(9000*time.Second))
	if first != 4000 || second != 4000 {
		t.Fatalf("terminal elapsed must ignore now: first=%d second=%d, want 4000", first, second)
	}
}

func TestIsTerminal(t *testing.T) {
	for _, status := range []string{"succeeded", "failed", "interrupted"} {
		if !IsTerminal(status) {
			t.Fatalf("%q must be terminal", status)
		}
	}
	for _, status := range []string{"running", "stale", ""} {
		if IsTerminal(status) {
			t.Fatalf("%q must not be terminal", status)
		}
	}
}
