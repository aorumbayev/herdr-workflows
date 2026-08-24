package history

import (
	"encoding/json"
	"testing"
)

const validRunID = "550e8400-e29b-41d4-a716-446655440000"

const validISO = "2026-08-20T12:00:00.000Z"

func asJSONValue(t *testing.T, v any) any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func validLiveSnapshot() map[string]any {
	return map[string]any{
		"version":       1,
		"id":            validRunID,
		"workflow":      "demo",
		"source":        "repo",
		"checkout_root": "/repo/a",
		"started_at":    validISO,
		"heartbeat_at":  validISO,
		"steps":         []any{},
	}
}

func TestIsSnapshotRejectsMalformedNestedStepFields(t *testing.T) {
	// This case is the same as test/history/history-types.test.ts "malformed nested step fields are rejected by guard".
	cases := []struct {
		name string
		snap map[string]any
	}{
		{
			name: "broken step object",
			snap: func() map[string]any {
				s := validLiveSnapshot()
				s["steps"] = []any{map[string]any{"label": "broken"}}
				return s
			}(),
		},
		{
			name: "non-ISO started_at",
			snap: func() map[string]any {
				s := validLiveSnapshot()
				s["started_at"] = "not-a-date"
				return s
			}(),
		},
		{
			name: "terminal status without finished_at",
			snap: func() map[string]any {
				s := validLiveSnapshot()
				s["status"] = "succeeded"
				return s
			}(),
		},
		{
			name: "terminal status with current_step",
			snap: func() map[string]any {
				s := validLiveSnapshot()
				s["finished_at"] = validISO
				s["status"] = "succeeded"
				s["current_step"] = map[string]any{
					"phase":         "main",
					"workflow":      "demo",
					"workflow_path": []any{"demo"},
					"ordinal":       1,
					"total":         1,
					"action":        "run",
					"label":         "x",
					"started_at":    validISO,
				}
				return s
			}(),
		},
		{
			name: "ordinal zero",
			snap: func() map[string]any {
				s := validLiveSnapshot()
				s["steps"] = []any{map[string]any{
					"phase":         "main",
					"workflow":      "demo",
					"workflow_path": []any{"demo"},
					"ordinal":       0,
					"total":         1,
					"action":        "run",
					"label":         "x",
					"finished_at":   validISO,
					"outcome":       "succeeded",
				}}
				return s
			}(),
		},
		{
			name: "nested step omits parent_ordinal",
			snap: func() map[string]any {
				s := validLiveSnapshot()
				s["finished_at"] = validISO
				s["status"] = "succeeded"
				s["steps"] = []any{map[string]any{
					"phase":         "main",
					"workflow":      "child",
					"workflow_path": []any{"demo", "child"},
					"ordinal":       1,
					"total":         1,
					"action":        "run",
					"label":         "inner",
					"finished_at":   validISO,
					"outcome":       "succeeded",
				}}
				return s
			}(),
		},
		{
			name: "top-level step invents parent_ordinal",
			snap: func() map[string]any {
				s := validLiveSnapshot()
				s["finished_at"] = validISO
				s["status"] = "succeeded"
				s["steps"] = []any{map[string]any{
					"phase":          "main",
					"workflow":       "demo",
					"workflow_path":  []any{"demo"},
					"ordinal":        1,
					"total":          1,
					"parent_ordinal": 1,
					"action":         "run",
					"label":          "top",
					"finished_at":    validISO,
					"outcome":        "succeeded",
				}}
				return s
			}(),
		},
		{
			name: "nested current_step omits parent_ordinal",
			snap: func() map[string]any {
				s := validLiveSnapshot()
				s["current_step"] = map[string]any{
					"phase":         "main",
					"workflow":      "child",
					"workflow_path": []any{"demo", "child"},
					"ordinal":       1,
					"total":         1,
					"action":        "run",
					"label":         "inner",
					"started_at":    validISO,
				}
				return s
			}(),
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if IsSnapshot(asJSONValue(t, c.snap)) {
				t.Fatalf("accepted malformed snapshot %s", c.name)
			}
		})
	}
}

func TestIsSnapshotRejectsProgressAndProjectionVocabulary(t *testing.T) {
	withOutcome := func(outcome string) map[string]any {
		s := validLiveSnapshot()
		s["steps"] = []any{map[string]any{
			"phase":         "main",
			"workflow":      "demo",
			"workflow_path": []any{"demo"},
			"ordinal":       1,
			"total":         1,
			"action":        "run",
			"label":         "x",
			"finished_at":   validISO,
			"outcome":       outcome,
		}}
		return s
	}
	if IsSnapshot(asJSONValue(t, withOutcome("ok"))) {
		t.Fatal(`outcome "ok" (ProgressOutcome) must not be execution vocabulary`)
	}

	stale := validLiveSnapshot()
	stale["finished_at"] = validISO
	stale["status"] = "stale"
	if IsSnapshot(asJSONValue(t, stale)) {
		t.Fatal(`status "stale" (projection) must not be a terminal status`)
	}
}

func TestIsSnapshotTruncatedOnlyLiteralTrue(t *testing.T) {
	// This case is the same as test/history/history-types.test.ts "truncated step fact is accepted only as literal true".
	withTruncated := func(truncated any) map[string]any {
		s := validLiveSnapshot()
		s["id"] = validRunID
		s["steps"] = []any{map[string]any{
			"phase":         "main",
			"workflow":      "demo",
			"workflow_path": []any{"demo"},
			"ordinal":       1,
			"total":         1,
			"action":        "herdr",
			"label":         "herdr pane.read",
			"finished_at":   validISO,
			"outcome":       "succeeded",
			"truncated":     truncated,
		}}
		return s
	}
	if !IsSnapshot(asJSONValue(t, withTruncated(true))) {
		t.Fatal("truncated: true must be accepted")
	}
	if IsSnapshot(asJSONValue(t, withTruncated(false))) {
		t.Fatal("truncated: false must be rejected")
	}
	if IsSnapshot(asJSONValue(t, withTruncated("yes"))) {
		t.Fatal(`truncated: "yes" must be rejected`)
	}
}

func TestParseFailureFactVerdictAndStreamOptional(t *testing.T) {
	base := func() FailureFact {
		fact, ok := parseFailureFact(map[string]any{"action": "agent", "verdict": "REJECT", "stream": "response"})
		if !ok {
			t.Fatal("parse")
		}
		return fact
	}()
	if base.Verdict != "REJECT" || base.Stream != "response" {
		t.Fatalf("%+v", base)
	}
	legacy, ok := parseFailureFact(map[string]any{"action": "run", "exit_code": 1})
	if !ok || legacy.Verdict != "" || legacy.Stream != "" || legacy.ExitCode == nil || *legacy.ExitCode != 1 {
		t.Fatalf("v1 compatible %+v", legacy)
	}
}
