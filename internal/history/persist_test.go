package history

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/config"
)

func TestLaterWriteRecoversCompleteStateAfterMissedIntermediate(t *testing.T) {
	// This case is the same as test/history/history-store.test.ts "later write recovers complete state after missed intermediate".
	_, checkout, getenv := testWriterEnv(t)
	w := NewWriter(getenv)
	defer w.Dispose()
	claimed := w.Claim(ClaimMeta{Workflow: "demo", Source: "repo", CheckoutRoot: checkout})
	if claimed.State != "claimed" {
		t.Fatalf("claim = %+v", claimed)
	}
	id := claimed.ID
	started := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	w.SetCurrentStep(CurrentStep{
		StepIdentity: StepIdentity{
			Phase: "main", Workflow: "demo", WorkflowPath: []string{"demo"},
			Ordinal: 1, Total: 2, Action: "run", Label: "one",
		},
		StartedAt: started,
	})
	w.RecordStep(StepRecord{
		StepIdentity: StepIdentity{
			Phase: "main", Workflow: "demo", WorkflowPath: []string{"demo"},
			Ordinal: 1, Total: 2, Action: "run", Label: "one",
		},
		FinishedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Outcome:    "succeeded",
	})
	snap, err := ReadSnapshot(id, getenv)
	if err != nil {
		t.Fatal(err)
	}
	if snap == nil || len(snap.Steps) != 1 {
		t.Fatalf("steps = %+v", snap)
	}
	if snap.CurrentStep != nil {
		t.Fatalf("current_step = %+v", snap.CurrentStep)
	}
}

func TestQueuedPersistsDrainBeforeFinalizeWins(t *testing.T) {
	// This case is the same as test/history/history-store.test.ts "queued persists drain before finalize wins".
	_, checkout, getenv := testWriterEnv(t)
	w := NewWriter(getenv)
	defer w.Dispose()
	claimed := w.Claim(ClaimMeta{Workflow: "demo", Source: "repo", CheckoutRoot: checkout})
	if claimed.State != "claimed" {
		t.Fatalf("claim = %+v", claimed)
	}
	started := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	done := make(chan struct{}, 3)
	go func() {
		w.SetCurrentStep(CurrentStep{
			StepIdentity: StepIdentity{
				Phase: "main", Workflow: "demo", WorkflowPath: []string{"demo"},
				Ordinal: 1, Total: 1, Action: "run", Label: "one",
			},
			StartedAt: started,
		})
		done <- struct{}{}
	}()
	go func() { w.Touch(); done <- struct{}{} }()
	go func() {
		w.RecordStep(StepRecord{
			StepIdentity: StepIdentity{
				Phase: "main", Workflow: "demo", WorkflowPath: []string{"demo"},
				Ordinal: 1, Total: 1, Action: "run", Label: "one",
			},
			FinishedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
			Outcome:    "succeeded",
		})
		done <- struct{}{}
	}()
	for range 3 {
		<-done
	}
	w.Finalize("succeeded", FinalizeOpts{})
	snap, err := ReadSnapshot(claimed.ID, getenv)
	if err != nil {
		t.Fatal(err)
	}
	if snap == nil || snap.Status != "succeeded" || len(snap.Steps) != 1 || snap.CurrentStep != nil {
		t.Fatalf("snapshot = %+v", snap)
	}
}

func TestHeartbeatUpdatesColumnWithoutRewritingSnapshotBlob(t *testing.T) {
	_, checkout, getenv := testWriterEnv(t)
	w := NewWriter(getenv)
	defer w.Dispose()
	claimed := w.Claim(ClaimMeta{Workflow: "demo", Source: "repo", CheckoutRoot: checkout})
	if claimed.State != "claimed" {
		t.Fatalf("claim = %+v", claimed)
	}
	id := claimed.ID
	before := snapshotBlob(t, id, getenv)
	time.Sleep(2 * time.Millisecond)
	w.Touch()
	after := snapshotBlob(t, id, getenv)
	if before != after {
		t.Fatal("heartbeat rewrote snapshot blob")
	}
	hb := heartbeatColumn(t, id, getenv)
	if hb == "" {
		t.Fatal("heartbeat_at empty")
	}
}

func snapshotBlob(t *testing.T, id string, getenv config.Env) string {
	t.Helper()
	db, err := openHistory(getenv)
	if err != nil {
		t.Fatal(err)
	}
	var blob string
	if err := db.QueryRow(`SELECT snapshot FROM runs WHERE id=?`, id).Scan(&blob); err != nil {
		t.Fatal(err)
	}
	return blob
}

func heartbeatColumn(t *testing.T, id string, getenv config.Env) string {
	t.Helper()
	db, err := openHistory(getenv)
	if err != nil {
		t.Fatal(err)
	}
	var at string
	if err := db.QueryRow(`SELECT heartbeat_at FROM runs WHERE id=?`, id).Scan(&at); err != nil {
		t.Fatal(err)
	}
	return at
}

func TestHistoryDSNEscapesURIDelimiters(t *testing.T) {
	dsn := historyDSN("/tmp/a?b#c%d/history.db")
	if !strings.HasPrefix(dsn, "file:/tmp/a%3Fb%23c%25d/history.db?") {
		t.Fatalf("dsn = %q", dsn)
	}
}

func TestHistoryDSNSetsBusyTimeoutBeforeWAL(t *testing.T) {
	dsn := historyDSN("/tmp/history.db")
	busy := strings.Index(dsn, "busy_timeout")
	wal := strings.Index(dsn, "journal_mode")
	if busy < 0 || wal < 0 || busy > wal {
		t.Fatalf("dsn = %q, want busy_timeout before journal_mode", dsn)
	}
}

func TestFailedMigrationLeavesNoOpenTransaction(t *testing.T) {
	_, _, getenv := testWriterEnv(t)
	db, err := openHistory(getenv)
	if err != nil {
		t.Fatal(err)
	}
	if err := migrateSchema(db, "SELECT no_such_column;"); err == nil {
		t.Fatal("broken migration succeeded")
	}
	if err := migrateSchema(db, schemaSQL); err != nil {
		t.Fatalf("retry after a failed migration: %v", err)
	}
	if err := ScratchSet("k", "v", getenv); err != nil {
		t.Fatalf("write after a failed migration: %v", err)
	}
}

func TestPersistRestoresARowThatVanished(t *testing.T) {
	_, checkout, getenv := testWriterEnv(t)
	w := NewWriter(getenv)
	defer w.Dispose()
	if w.Claim(ClaimMeta{Workflow: "demo", Source: "repo", CheckoutRoot: checkout}).State != "claimed" {
		t.Fatal("claim")
	}
	db, err := openHistory(getenv)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DELETE FROM runs WHERE id=?`, w.ID()); err != nil {
		t.Fatal(err)
	}
	w.Finalize("succeeded", FinalizeOpts{})
	snap, err := ReadSnapshot(w.ID(), getenv)
	if err != nil {
		t.Fatal(err)
	}
	if snap == nil || snap.Status != "succeeded" {
		t.Fatalf("snapshot = %+v", snap)
	}
}

func TestExpiredRunIsNotResurrectedByALateWrite(t *testing.T) {
	_, checkout, getenv := testWriterEnv(t)
	w := NewWriter(getenv)
	defer w.Dispose()
	if w.Claim(ClaimMeta{Workflow: "demo", Source: "repo", CheckoutRoot: checkout}).State != "claimed" {
		t.Fatal("claim")
	}
	db, err := openHistory(getenv)
	if err != nil {
		t.Fatal(err)
	}
	if err := expireRun(db, w.ID()); err != nil {
		t.Fatal(err)
	}
	w.Finalize("succeeded", FinalizeOpts{})
	loaded, err := loadSnapshot(w.ID(), getenv)
	if err != nil || !loaded.Expired {
		t.Fatalf("loaded = %+v err=%v", loaded, err)
	}
}

func TestOldSchemaDatabaseIsRebuilt(t *testing.T) {
	_, checkout, getenv := testWriterEnv(t)
	path := historyDBPath(getenv)
	raw, err := sql.Open("sqlite", historyDSN(path))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, workflow TEXT NOT NULL);
		INSERT INTO runs (id, workflow) VALUES ('stale-row', 'old');
		CREATE TABLE scratch (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
		INSERT INTO scratch (key, value, updated_at) VALUES ('durable.key', 'kept', '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	listed := ListRuns(ListFilter{}, getenv)
	if !listed.OK || len(listed.Runs) != 0 || len(listed.Incompatible) != 0 {
		t.Fatalf("list after rebuild = %+v", listed)
	}
	w := NewWriter(getenv)
	defer w.Dispose()
	if w.Claim(ClaimMeta{Workflow: "demo", Source: "repo", CheckoutRoot: checkout}).State != "claimed" {
		t.Fatal("claim after rebuild")
	}
	if value, err := ScratchGet("durable.key", getenv); err != nil || value != "kept" {
		t.Fatalf("scratch after rebuild = %q, %v; want durable keys to survive", value, err)
	}
}

func TestHistoryOpensUnderURIDelimiterPath(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), "st?ate#1%2f")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	getenv := func(key string) string {
		if key == "HERDR_PLUGIN_STATE_DIR" {
			return stateDir
		}
		return os.Getenv(key)
	}
	if err := ScratchSet("k", "v", getenv); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "history.db")); err != nil {
		t.Fatalf("database was not created inside the state directory: %v", err)
	}
}
