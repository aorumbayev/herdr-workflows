package history

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func seedTerminalRuns(t *testing.T, count int, base time.Time) []string {
	t.Helper()
	ids := make([]string, 0, count)
	for i := range count {
		id := AllocateRunID()
		writeListedSnapshot(t, terminalSnapshot(id, "wf", "/repo/a", base.Add(-time.Duration(i)*time.Second), ""))
		ids = append(ids, id)
	}
	return ids
}

func collectPages(t *testing.T, limit int, hook func(page int)) []string {
	t.Helper()
	var seen []string
	var after *Cursor
	for page := 1; ; page++ {
		listed := ListRuns(ListFilter{Limit: limit, After: after})
		if !listed.OK {
			t.Fatalf("page %d = %+v", page, listed)
		}
		if len(listed.Runs) > limit {
			t.Fatalf("page %d has %d runs", page, len(listed.Runs))
		}
		for _, r := range listed.Runs {
			seen = append(seen, r.ID)
		}
		if listed.NextCursor == nil {
			return seen
		}
		token := listed.NextCursor.Encode()
		decoded, ok := DecodeCursor(token)
		if !ok || decoded != *listed.NextCursor {
			t.Fatalf("cursor round trip: %q", token)
		}
		after = &decoded
		if hook != nil {
			hook(page)
		}
	}
}

func TestListRunsPagesPastFortyWithoutLossOrDuplicates(t *testing.T) {
	testWriterEnv(t)
	now := time.Now()
	want := seedTerminalRuns(t, 60, now)
	seen := collectPages(t, 25, nil)
	if len(seen) != 60 {
		t.Fatalf("saw %d of 60", len(seen))
	}
	unique := map[string]bool{}
	for _, id := range seen {
		if unique[id] {
			t.Fatalf("duplicate %s", id)
		}
		unique[id] = true
	}
	for i, id := range want {
		if seen[i] != id {
			t.Fatalf("order differs at %d", i)
		}
	}
	first := ListRuns(ListFilter{})
	if len(first.Runs) != DefaultListLimit || first.NextCursor == nil {
		t.Fatalf("default page = %d runs, cursor %v", len(first.Runs), first.NextCursor)
	}
}

func TestListRunsCursorIsStableWhenNewerRunArrives(t *testing.T) {
	testWriterEnv(t)
	now := time.Now()
	want := seedTerminalRuns(t, 12, now)
	seen := collectPages(t, 5, func(page int) {
		if page == 1 {
			writeListedSnapshot(t, terminalSnapshot(AllocateRunID(), "wf", "/repo/a", now.Add(time.Minute), ""))
		}
	})
	if len(seen) != 12 {
		t.Fatalf("saw %d of 12: %v", len(seen), seen)
	}
	for i, id := range want {
		if seen[i] != id {
			t.Fatalf("sequence changed at %d", i)
		}
	}
	fresh := ListRuns(ListFilter{Limit: 1})
	if fresh.Runs[0].ID == want[0] {
		t.Fatal("newer run is not first on a fresh page")
	}
}

func TestDecodeCursorRejectsGarbage(t *testing.T) {
	for _, token := range []string{"", "!!!", "bm90LWEtY3Vyc29y", Cursor{StartedAt: "yesterday", ID: validRunID}.Encode(), Cursor{StartedAt: "2026-01-01T00:00:00Z", ID: "short"}.Encode()} {
		if _, ok := DecodeCursor(token); ok {
			t.Fatalf("accepted %q", token)
		}
	}
	good := Cursor{StartedAt: "2026-01-01T00:00:00.000Z", ID: validRunID}
	if got, ok := DecodeCursor(good.Encode()); !ok || got != good {
		t.Fatalf("round trip = %+v %v", got, ok)
	}
}

func TestReadsNeverCreateOrMigrateHistory(t *testing.T) {
	stateDir, _ := testWriterEnv(t)
	absent := filepath.Join(stateDir, "absent")
	t.Setenv("HERDR_PLUGIN_STATE_DIR", absent)
	listed := ListRuns(ListFilter{})
	if !listed.OK || len(listed.Runs) != 0 {
		t.Fatalf("missing state dir = %+v", listed)
	}
	if _, err := os.Stat(absent); !os.IsNotExist(err) {
		t.Fatalf("read created %s: %v", absent, err)
	}
	t.Setenv("HERDR_PLUGIN_STATE_DIR", stateDir)
	path := filepath.Join(stateDir, historyDBName)
	listed = ListRuns(ListFilter{})
	if !listed.OK || len(listed.Runs) != 0 {
		t.Fatalf("missing db = %+v", listed)
	}
	if RunDetail(validRunID, time.Time{}).Detail.Kind != "missing" {
		t.Fatal("missing db detail kind")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("read created %s: %v", path, err)
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`PRAGMA user_version = 9`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	listed = ListRuns(ListFilter{})
	if listed.OK || listed.Unavailable || listed.IncompatibleSchema != 9 {
		t.Fatalf("old schema = %+v", listed)
	}
	detail := RunDetail(validRunID, time.Time{}).Detail
	if detail.Kind != "incompatible" || detail.Message == "" {
		t.Fatalf("old schema detail = %+v", detail)
	}
	db, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	var version int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil || version != 9 {
		t.Fatalf("read migrated the schema: version=%d err=%v", version, err)
	}
}

func TestSummaryCarriesHeartbeatAndCurrentStep(t *testing.T) {
	iso := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	snap := Snapshot{
		Version: 1, ID: validRunID, Workflow: "demo", Source: "repo", CheckoutRoot: "/repo/a",
		StartedAt: iso, HeartbeatAt: iso, Steps: []StepRecord{},
		CurrentStep: &CurrentStep{StepIdentity: StepIdentity{Phase: "main", Workflow: "demo", WorkflowPath: []string{"demo"}, Ordinal: 1, Total: 2, Action: "run", Label: "build"}, StartedAt: iso},
	}
	s := ToSummary(snap, time.Now())
	if s.HeartbeatAt != iso || s.CurrentStep == nil || s.CurrentStep.Label != "build" || s.CurrentStep.Total != 2 {
		t.Fatalf("%+v", s)
	}
	if len(s.StepLabels) != 1 || s.Progress == nil || s.Progress.Done != 0 || s.Progress.Total != 2 {
		t.Fatalf("%+v", s)
	}
	snap.CurrentStep = nil
	s = ToSummary(snap, time.Now())
	if s.CurrentStep != nil || s.StepLabels == nil || len(s.StepLabels) != 0 || s.Progress != nil || s.Status != "running" {
		t.Fatalf("claimed run without a step = %+v", s)
	}
}
