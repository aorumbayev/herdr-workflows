package history

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/credentials"
	sqlite "modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

const (
	RetentionKeep = 50
	historyDBName = "history.db"
)

const schemaSQL = `
CREATE TABLE IF NOT EXISTS runs (
	id TEXT PRIMARY KEY,
	version INTEGER NOT NULL,
	expired INTEGER NOT NULL DEFAULT 0,
	workflow TEXT NOT NULL,
	title TEXT NOT NULL DEFAULT '',
	source TEXT NOT NULL,
	checkout_root TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT '',
	started_at TEXT NOT NULL,
	heartbeat_at TEXT NOT NULL,
	finished_at TEXT NOT NULL DEFAULT '',
	current_label TEXT NOT NULL DEFAULT '',
	progress_done INTEGER,
	progress_total INTEGER,
	step_labels TEXT NOT NULL DEFAULT '[]',
	failure_action TEXT NOT NULL DEFAULT '',
	failure_exit_code INTEGER,
	failure_method TEXT NOT NULL DEFAULT '',
	failure_coordination TEXT NOT NULL DEFAULT '',
	failure_step_id TEXT NOT NULL DEFAULT '',
	snapshot TEXT
);
CREATE INDEX IF NOT EXISTS runs_list_idx ON runs (expired, started_at DESC, id);
CREATE INDEX IF NOT EXISTS runs_checkout_idx ON runs (checkout_root, expired, started_at DESC);
CREATE TABLE IF NOT EXISTS artifacts (
	run_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	body BLOB NOT NULL,
	PRIMARY KEY (run_id, kind)
);
CREATE TABLE IF NOT EXISTS scratch (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
`

var (
	dbsMu sync.Mutex
	dbs   = map[string]*sql.DB{}
)

func historyDBPath(getenv config.Env) string {
	dir, err := config.PluginStateDir(getenv)
	if err != nil {
		return ""
	}
	return filepath.Join(dir, historyDBName)
}

func openHistory(getenv config.Env) (*sql.DB, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	state, err := config.PluginStateDir(getenv)
	if err != nil {
		return nil, err
	}
	if err := credentials.AssertCredentialStoreSafe(state, historyACLOpts()); err != nil {
		return nil, err
	}
	path := filepath.Join(state, historyDBName)
	dbsMu.Lock()
	defer dbsMu.Unlock()
	if db := dbs[path]; db != nil {
		if err := credentials.AssertPrivateCredentialFile(path, historyACLOpts()); err != nil {
			_ = db.Close()
			delete(dbs, path)
			return nil, err
		}
		return db, nil
	}
	db, err := sql.Open("sqlite", historyDSN(path))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(8)
	if err := pingMigrate(db, path); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := credentials.AssertPrivateCredentialFile(path, historyACLOpts()); err != nil {
		_ = db.Close()
		return nil, err
	}
	lockCompanions(path)
	dbs[path] = db
	return db, nil
}

func historyDSN(path string) string {
	return "file:" + uriPath(path) + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"
}

// SQLite ends a file: URI path at '?' or '#' and percent-decodes it, so those
// bytes must be escaped or the db lands off the ACL-checked path.
func uriPath(path string) string {
	var b strings.Builder
	for _, r := range filepath.ToSlash(path) {
		switch r {
		case '%', '?', '#':
			fmt.Fprintf(&b, "%%%02X", r)
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

func pingMigrate(db *sql.DB, path string) error {
	var last error
	for range 8 {
		if err := db.Ping(); err != nil {
			last = err
			if isBusy(err) {
				time.Sleep(25 * time.Millisecond)
				continue
			}
			return err
		}
		if _, err := os.Stat(path); err == nil {
			_ = os.Chmod(path, 0o600)
		}
		if err := migrateSchema(db, schemaSQL); err != nil {
			last = err
			if isBusy(err) {
				time.Sleep(25 * time.Millisecond)
				continue
			}
			return err
		}
		return nil
	}
	return last
}

// migrateSchema owns one connection so a failed statement can roll the write
// transaction back instead of stranding it open in the pool.
func migrateSchema(db *sql.DB, ddl string) error {
	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close() }()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	if _, err := conn.ExecContext(ctx, ddl); err != nil {
		_, _ = conn.ExecContext(ctx, "ROLLBACK")
		return err
	}
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		_, _ = conn.ExecContext(ctx, "ROLLBACK")
		return err
	}
	return nil
}

func lockCompanions(path string) {
	for _, suffix := range []string{"-wal", "-shm"} {
		p := path + suffix
		if _, err := os.Stat(p); err == nil {
			_ = os.Chmod(p, 0o600)
		}
	}
}

func isBusy(err error) bool {
	var se *sqlite.Error
	if errors.As(err, &se) {
		return se.Code() == sqlite3.SQLITE_BUSY || se.Code() == sqlite3.SQLITE_LOCKED
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "busy") || strings.Contains(msg, "locked")
}

func isUniqueConstraint(err error) bool {
	var se *sqlite.Error
	if errors.As(err, &se) {
		switch se.Code() {
		case sqlite3.SQLITE_CONSTRAINT, sqlite3.SQLITE_CONSTRAINT_PRIMARYKEY, sqlite3.SQLITE_CONSTRAINT_UNIQUE:
			return true
		}
	}
	return strings.Contains(strings.ToLower(err.Error()), "unique constraint")
}

func insertClaim(snap Snapshot, getenv config.Env) error {
	db, err := openHistory(getenv)
	if err != nil {
		return err
	}
	return upsertRun(db, snap, true)
}

func persistRun(snap Snapshot, getenv config.Env) error {
	db, err := openHistory(getenv)
	if err != nil {
		return err
	}
	return upsertRun(db, snap, false)
}

func upsertRun(db *sql.DB, snap Snapshot, insert bool) error {
	blob, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	sum := ToSummary(snap, time.Now())
	args := []any{
		snap.Version, snap.Workflow, snap.Title, snap.Source, snap.CheckoutRoot, snap.Status,
		snap.StartedAt, snap.HeartbeatAt, snap.FinishedAt, sum.CurrentLabel, progressDone(sum), progressTotal(sum),
		labelsJSON(sum.StepLabels), failureAction(sum), failureExit(sum), failureMethod(sum), failureCoord(sum), failureStepID(sum), string(blob), snap.ID,
	}
	if insert {
		_, err = db.Exec(`INSERT INTO runs (
			id, version, expired, workflow, title, source, checkout_root, status,
			started_at, heartbeat_at, finished_at, current_label, progress_done, progress_total,
			step_labels, failure_action, failure_exit_code, failure_method, failure_coordination, failure_step_id, snapshot
		) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			snap.ID, snap.Version, snap.Workflow, snap.Title, snap.Source, snap.CheckoutRoot, snap.Status,
			snap.StartedAt, snap.HeartbeatAt, snap.FinishedAt, sum.CurrentLabel, progressDone(sum), progressTotal(sum),
			labelsJSON(sum.StepLabels), failureAction(sum), failureExit(sum), failureMethod(sum), failureCoord(sum), failureStepID(sum), string(blob),
		)
		return err
	}
	res, err := db.Exec(`UPDATE runs SET
		version=?, workflow=?, title=?, source=?, checkout_root=?, status=?,
		started_at=?, heartbeat_at=?, finished_at=?, current_label=?, progress_done=?, progress_total=?,
		step_labels=?, failure_action=?, failure_exit_code=?, failure_method=?, failure_coordination=?, failure_step_id=?, snapshot=?
		WHERE id=? AND expired=0`, args...)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err == nil && n == 0 {
		return restoreRun(db, snap, sum, string(blob))
	}
	return nil
}

// restoreRun re-inserts a row that vanished under a live writer. An expired
// row conflicts and stays expired.
func restoreRun(db *sql.DB, snap Snapshot, sum Summary, blob string) error {
	_, err := db.Exec(`INSERT INTO runs (
		id, version, expired, workflow, title, source, checkout_root, status,
		started_at, heartbeat_at, finished_at, current_label, progress_done, progress_total,
		step_labels, failure_action, failure_exit_code, failure_method, failure_coordination, failure_step_id, snapshot
	) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
		snap.ID, snap.Version, snap.Workflow, snap.Title, snap.Source, snap.CheckoutRoot, snap.Status,
		snap.StartedAt, snap.HeartbeatAt, snap.FinishedAt, sum.CurrentLabel, progressDone(sum), progressTotal(sum),
		labelsJSON(sum.StepLabels), failureAction(sum), failureExit(sum), failureMethod(sum), failureCoord(sum), failureStepID(sum), blob,
	)
	return err
}

func updateHeartbeat(id, at string, getenv config.Env) error {
	db, err := openHistory(getenv)
	if err != nil {
		return err
	}
	_, err = db.Exec(`UPDATE runs SET heartbeat_at=? WHERE id=? AND expired=0`, at, id)
	return err
}

func loadRunRow(id string, getenv config.Env) (snapshotLoad, error) {
	db, err := openHistory(getenv)
	if err != nil {
		return snapshotLoad{}, err
	}
	var version, expired int
	var heartbeat string
	var blob sql.NullString
	err = db.QueryRow(`SELECT version, expired, heartbeat_at, snapshot FROM runs WHERE id=?`, id).Scan(&version, &expired, &heartbeat, &blob)
	if errors.Is(err, sql.ErrNoRows) {
		return snapshotLoad{}, nil
	}
	if err != nil {
		return snapshotLoad{}, err
	}
	if expired == 1 {
		return snapshotLoad{Expired: true}, nil
	}
	if version != SnapshotVersion {
		return snapshotLoad{Incompatible: &IncompatibleSnapshot{ID: id, Version: version}}, nil
	}
	if !blob.Valid || blob.String == "" {
		return snapshotLoad{}, nil
	}
	var v any
	if err := json.Unmarshal([]byte(blob.String), &v); err != nil {
		return snapshotLoad{}, nil
	}
	snap, ok := parseSnapshotValue(v)
	if !ok || snap.ID != id {
		return snapshotLoad{}, nil
	}
	snap.HeartbeatAt = heartbeat
	return snapshotLoad{Snap: &snap}, nil
}

func listRunSummaries(now time.Time, getenv config.Env) ([]Summary, []IncompatibleSnapshot, []string, error) {
	db, err := openHistory(getenv)
	if err != nil {
		return nil, nil, nil, err
	}
	incompat, err := listIncompatible(db)
	if err != nil {
		return nil, nil, nil, err
	}
	rows, err := db.Query(`SELECT id, workflow, title, source, checkout_root, status, started_at, heartbeat_at, finished_at,
		current_label, progress_done, progress_total, step_labels,
		failure_action, failure_exit_code, failure_method, failure_coordination, failure_step_id
		FROM runs WHERE expired=0 AND version=?`, SnapshotVersion)
	if err != nil {
		return nil, nil, nil, err
	}
	defer func() { _ = rows.Close() }()
	var items []Summary
	roots := map[string]struct{}{}
	for rows.Next() {
		item, root, ok := scanSummary(rows, now)
		if !ok {
			continue
		}
		items = append(items, item)
		roots[root] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, nil, err
	}
	checkoutRoots := make([]string, 0, len(roots))
	for r := range roots {
		checkoutRoots = append(checkoutRoots, r)
	}
	return items, incompat, checkoutRoots, nil
}

func listIncompatible(db *sql.DB) ([]IncompatibleSnapshot, error) {
	rows, err := db.Query(`SELECT id, version FROM runs WHERE expired=0 AND version!=?`, SnapshotVersion)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []IncompatibleSnapshot
	for rows.Next() {
		var row IncompatibleSnapshot
		if err := rows.Scan(&row.ID, &row.Version); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func scanSummary(rows *sql.Rows, now time.Time) (Summary, string, bool) {
	var item Summary
	var heartbeat string
	var progressDone, progressTotal, failExit sql.NullInt64
	var labelsRaw, failAction, failMethod, failCoord, failStep string
	if err := rows.Scan(&item.ID, &item.Workflow, &item.Title, &item.Source, &item.CheckoutRoot, &item.Status,
		&item.StartedAt, &heartbeat, &item.FinishedAt, &item.CurrentLabel, &progressDone, &progressTotal, &labelsRaw,
		&failAction, &failExit, &failMethod, &failCoord, &failStep); err != nil {
		return Summary{}, "", false
	}
	item.DisplayID = DisplayRunID(item.ID)
	item.Status = projectStatus(item.Status, heartbeat, now)
	item.ElapsedMs = elapsedMsBetween(item.StartedAt, item.FinishedAt, item.Status, now)
	if progressDone.Valid && progressTotal.Valid {
		item.Progress = &Progress{Done: int(progressDone.Int64), Total: int(progressTotal.Int64)}
	}
	if labelsRaw != "" && labelsRaw != "[]" {
		_ = json.Unmarshal([]byte(labelsRaw), &item.StepLabels)
	}
	if failAction != "" {
		fact := &FailureFact{Action: failAction, Method: failMethod, Coordination: failCoord, StepID: failStep}
		if failExit.Valid {
			n := int(failExit.Int64)
			fact.ExitCode = &n
		}
		item.Failure = fact
	}
	return item, item.CheckoutRoot, true
}

func retentionCleanup(getenv config.Env) error {
	db, err := openHistory(getenv)
	if err != nil {
		return err
	}
	ids, err := terminalRunIDs(db)
	if err != nil {
		return err
	}
	if len(ids) <= RetentionKeep {
		return nil
	}
	for _, id := range ids[:len(ids)-RetentionKeep] {
		if err := expireRun(db, id); err != nil {
			return err
		}
	}
	return nil
}

func terminalRunIDs(db *sql.DB) ([]string, error) {
	rows, err := db.Query(`SELECT id FROM runs WHERE expired=0 AND status!='' ORDER BY started_at ASC, id ASC`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// expireRun strips one run in a single transaction so an interrupted pass
// never leaves blobs behind a row already marked expired.
func expireRun(db *sql.DB, id string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`UPDATE runs SET expired=1, snapshot=NULL, current_label='', progress_done=NULL, progress_total=NULL,
		step_labels='[]', failure_action='', failure_exit_code=NULL, failure_method='', failure_coordination='', failure_step_id='' WHERE id=?`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM artifacts WHERE run_id=?`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM scratch WHERE key LIKE ?`, id+".%"); err != nil {
		return err
	}
	return tx.Commit()
}

func putArtifact(db *sql.DB, id, kind, body string) error {
	_, err := db.Exec(`INSERT INTO artifacts(run_id, kind, body) VALUES(?,?,?)
		ON CONFLICT(run_id, kind) DO UPDATE SET body=excluded.body`, id, kind, []byte(body))
	return err
}

func getArtifact(db *sql.DB, id, kind string) (string, bool, error) {
	var body []byte
	err := db.QueryRow(`SELECT body FROM artifacts WHERE run_id=? AND kind=?`, id, kind).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return string(body), true, nil
}

func labelsJSON(labels []string) string {
	if len(labels) == 0 {
		return "[]"
	}
	raw, err := json.Marshal(labels)
	if err != nil {
		return "[]"
	}
	return string(raw)
}

func progressDone(sum Summary) any {
	if sum.Progress == nil {
		return nil
	}
	return sum.Progress.Done
}

func progressTotal(sum Summary) any {
	if sum.Progress == nil {
		return nil
	}
	return sum.Progress.Total
}

func failureAction(sum Summary) string {
	if sum.Failure == nil {
		return ""
	}
	return sum.Failure.Action
}

func failureExit(sum Summary) any {
	if sum.Failure == nil || sum.Failure.ExitCode == nil {
		return nil
	}
	return *sum.Failure.ExitCode
}

func failureMethod(sum Summary) string {
	if sum.Failure == nil {
		return ""
	}
	return sum.Failure.Method
}

func failureCoord(sum Summary) string {
	if sum.Failure == nil {
		return ""
	}
	return sum.Failure.Coordination
}

func failureStepID(sum Summary) string {
	if sum.Failure == nil {
		return ""
	}
	return sum.Failure.StepID
}
