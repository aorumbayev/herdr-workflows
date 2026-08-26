package history

import (
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/engine"
)

func ProjectStatus(snap Snapshot, now time.Time) string {
	return projectStatus(snap.Status, snap.HeartbeatAt, now)
}

func projectStatus(status, heartbeatAt string, now time.Time) string {
	if IsTerminal(status) {
		return status
	}
	hb, ok := parseISOTime(heartbeatAt)
	if !ok || now.Sub(hb) >= StaleAfter {
		return "stale"
	}
	return "running"
}

func IsTerminal(status string) bool {
	switch status {
	case string(engine.StatusSucceeded), string(engine.StatusFailed), string(engine.StatusInterrupted):
		return true
	default:
		return false
	}
}

// LiveElapsedMs is a running run's wall-clock elapsed at now and a terminal run's recorded ElapsedMs.
func LiveElapsedMs(s Summary, now time.Time) int64 {
	return liveElapsedMs(s.StartedAt, s.FinishedAt, s.Status, s.ElapsedMs, now)
}

// LiveDetailElapsedMs is the detail-view counterpart of LiveElapsedMs.
func LiveDetailElapsedMs(d Detail, now time.Time) int64 {
	return liveElapsedMs(d.StartedAt, d.FinishedAt, d.Status, d.ElapsedMs, now)
}

func liveElapsedMs(startedAt, finishedAt, status string, recordedMs int64, now time.Time) int64 {
	if IsTerminal(status) {
		return recordedMs
	}
	if now.IsZero() {
		now = time.Now()
	}
	return elapsedMsBetween(startedAt, finishedAt, status, now)
}

func ToSummary(snap Snapshot, now time.Time) Summary {
	status := ProjectStatus(snap, now)
	item := Summary{
		ID:           snap.ID,
		DisplayID:    DisplayRunID(snap.ID),
		Workflow:     snap.Workflow,
		Title:        snap.Title,
		Source:       snap.Source,
		CheckoutRoot: snap.CheckoutRoot,
		Status:       status,
		StartedAt:    snap.StartedAt,
		FinishedAt:   snap.FinishedAt,
		ElapsedMs:    elapsedMs(snap, status, now),
		Failure:      failureFactOf(snap.Steps),
	}
	if p := progressOf(snap); p != nil {
		item.Progress = p
	}
	if snap.CurrentStep != nil {
		item.CurrentLabel = snap.CurrentStep.Label
	}
	var labels []string
	for _, step := range snap.Steps {
		labels = append(labels, step.Label)
	}
	if snap.CurrentStep != nil {
		labels = append(labels, snap.CurrentStep.Label)
	}
	if len(labels) > 0 {
		item.StepLabels = labels
	}
	return item
}

func DisplayRunID(id string) string {
	if len(id) < 8 {
		return id
	}
	return id[:8]
}

func failureFactOf(steps []StepRecord) *FailureFact {
	for i := len(steps) - 1; i >= 0; i-- {
		switch steps[i].Outcome {
		case string(engine.OutcomeFailed), string(engine.OutcomeFailedContinued), string(engine.OutcomeInterrupted):
			return steps[i].Failure
		}
	}
	return nil
}

func progressOf(snap Snapshot) *Progress {
	var totals []int
	done := 0
	for _, step := range snap.Steps {
		if step.Workflow == snap.Workflow && step.Phase == "main" {
			done++
			totals = append(totals, step.Total)
		}
	}
	total := 0
	hasTotal := false
	if snap.CurrentStep != nil && snap.CurrentStep.Workflow == snap.Workflow {
		total = snap.CurrentStep.Total
		hasTotal = true
	} else if len(totals) > 0 {
		total = totals[0]
		for _, n := range totals[1:] {
			if n > total {
				total = n
			}
		}
		hasTotal = true
	}
	if !hasTotal {
		return nil
	}
	return &Progress{Done: done, Total: total}
}

func elapsedMs(snap Snapshot, status string, now time.Time) int64 {
	return elapsedMsBetween(snap.StartedAt, snap.FinishedAt, status, now)
}

func elapsedMsBetween(startedAt, finishedAt, status string, now time.Time) int64 {
	started, ok := parseISOTime(startedAt)
	if !ok {
		return 0
	}
	end := started
	if finishedAt != "" {
		if finished, ok := parseISOTime(finishedAt); ok {
			end = finished
		}
	} else if status == "running" || status == "stale" {
		end = now
	}
	ms := end.Sub(started).Milliseconds()
	if ms < 0 {
		return 0
	}
	return ms
}

func parseISOTime(s string) (time.Time, bool) {
	for _, layout := range isoLayouts {
		if ts, err := time.Parse(layout, s); err == nil {
			return ts, true
		}
	}
	return time.Time{}, false
}
