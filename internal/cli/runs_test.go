package cli

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/history"
)

type machineOut struct {
	SchemaVersion int              `json:"schema_version"`
	OK            bool             `json:"ok"`
	Runs          []map[string]any `json:"runs"`
	NextCursor    *string          `json:"next_cursor"`
	Warnings      []map[string]any `json:"warnings"`
	Run           map[string]any   `json:"run"`
	Error         map[string]any   `json:"error"`
}

func decodeMachine(t *testing.T, got cliResult) machineOut {
	t.Helper()
	if strings.Count(got.stdout, "\n") != 1 || !strings.HasSuffix(got.stdout, "\n") {
		t.Fatalf("stdout is not one JSON line: %q", got.stdout)
	}
	var out machineOut
	if err := json.Unmarshal([]byte(got.stdout), &out); err != nil {
		t.Fatalf("stdout %q: %v", got.stdout, err)
	}
	if out.SchemaVersion != 1 {
		t.Fatalf("schema_version = %d", out.SchemaVersion)
	}
	return out
}

func expectMachineError(t *testing.T, got cliResult, code string) machineOut {
	t.Helper()
	if got.code != 1 {
		t.Fatalf("code = %d stdout = %q stderr = %q", got.code, got.stdout, got.stderr)
	}
	out := decodeMachine(t, got)
	if out.OK || out.Error["code"] != code {
		t.Fatalf("want error %s, got %q", code, got.stdout)
	}
	return out
}

func boardEnv(t *testing.T, root string) map[string]string {
	t.Helper()
	state := t.TempDir()
	if err := os.Chmod(state, 0o700); err != nil {
		t.Fatal(err)
	}
	return map[string]string{
		"HOME":                      t.TempDir(),
		"HERDR_PLUGIN_CONFIG_DIR":   t.TempDir(),
		"HERDR_PLUGIN_STATE_DIR":    state,
		"HERDR_WORKFLOWS_REPO_ROOT": root,
		childEnv:                    "1",
	}
}

func TestDetachedLaunchClaimsThenListsAndGets(t *testing.T) {
	root := t.TempDir()
	sentinel := filepath.Join(root, "done")
	writeWorkflow(t, root, "slow", fmt.Sprintf(`version: v1alpha1
title: Slow
inputs:
  token: text
steps:
  - run: ["sleep", "2"]
  - run: ["sh", "-c", "test -n \"$1\" && touch %s", "sh", "{{inputs.token}}"]
`, sentinel))
	env := boardEnv(t, root)
	secret := "s3cret-value-never-printed"

	launched := runCLI([]string{"run", "slow", "--detach", "--json", "--input", "token=" + secret}, root, env, "")
	if launched.code != 0 {
		t.Fatalf("code = %d stdout = %q stderr = %q", launched.code, launched.stdout, launched.stderr)
	}
	out := decodeMachine(t, launched)
	id, _ := out.Run["id"].(string)
	if _, ok := history.NormalizeRunUUID(id); !ok || !out.OK {
		t.Fatalf("launch = %q", launched.stdout)
	}
	if out.Run["status"] != "running" || out.Run["workflow"] != "slow" || out.Run["display_id"] != id[:8] {
		t.Fatalf("launch summary = %q", launched.stdout)
	}

	listed := decodeMachine(t, runCLI([]string{"runs", "list", "--json"}, root, env, ""))
	if len(listed.Runs) != 1 || listed.Runs[0]["id"] != id || listed.Runs[0]["status"] != "running" {
		t.Fatalf("list = %+v", listed)
	}
	if listed.NextCursor != nil || len(listed.Warnings) != 0 {
		t.Fatalf("list = %+v", listed)
	}

	var final machineOut
	var outputs []string
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		got := runCLI([]string{"runs", "get", id, "--json"}, root, env, "")
		if got.code != 0 {
			t.Fatalf("get code = %d stdout = %q stderr = %q", got.code, got.stdout, got.stderr)
		}
		final = decodeMachine(t, got)
		outputs = append(outputs, got.stdout, got.stderr)
		if history.IsTerminal(final.Run["status"].(string)) {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if final.Run["status"] != "succeeded" {
		t.Fatalf("final = %+v", final.Run)
	}
	if _, err := os.Stat(sentinel); err != nil {
		t.Fatalf("step 2 did not run: %v", err)
	}
	steps, _ := final.Run["steps"].([]any)
	if len(steps) != 2 {
		t.Fatalf("steps = %v", final.Run["steps"])
	}
	first := steps[0].(map[string]any)
	if first["ordinal"] != float64(1) || first["outcome"] != "succeeded" || first["action"] != "run" {
		t.Fatalf("step 1 = %v", first)
	}
	labels, _ := final.Run["step_labels"].([]any)
	progress, _ := final.Run["progress"].(map[string]any)
	if len(labels) != 2 || progress["done"] != float64(2) || progress["total"] != float64(2) {
		t.Fatalf("labels = %v progress = %v", labels, progress)
	}
	for _, key := range []string{"heartbeat_at", "finished_at", "started_at", "checkout_root", "source"} {
		if _, ok := final.Run[key]; !ok {
			t.Fatalf("detail lacks %s: %v", key, final.Run)
		}
	}

	again := decodeMachine(t, runCLI([]string{"runs", "list", "--json", "--status", "succeeded", "--checkout-root", root}, root, env, ""))
	if len(again.Runs) != 1 || again.Runs[0]["id"] != id {
		t.Fatalf("list after finish = %+v", again)
	}
	none := decodeMachine(t, runCLI([]string{"runs", "list", "--json", "--status", "running"}, root, env, ""))
	if len(none.Runs) != 0 {
		t.Fatalf("running filter = %+v", none)
	}

	outputs = append(outputs, launched.stdout, launched.stderr)
	for _, text := range outputs {
		if strings.Contains(text, secret) {
			t.Fatalf("secret leaked: %q", text)
		}
	}
}

func TestRunsListAndGetDistinguishEmptyMissingUnavailableIncompatible(t *testing.T) {
	root := t.TempDir()
	env := boardEnv(t, root)
	id := history.AllocateRunID()

	empty := decodeMachine(t, runCLI([]string{"runs", "list", "--json"}, root, env, ""))
	if !empty.OK || len(empty.Runs) != 0 || empty.NextCursor != nil || len(empty.Warnings) != 0 {
		t.Fatalf("empty = %+v", empty)
	}
	if _, err := os.Stat(filepath.Join(env["HERDR_PLUGIN_STATE_DIR"], "history.db")); !os.IsNotExist(err) {
		t.Fatalf("read created history.db: %v", err)
	}
	expectMachineError(t, runCLI([]string{"runs", "get", id, "--json"}, root, env, ""), "run_not_found")
	expectMachineError(t, runCLI([]string{"runs", "get", "not-a-uuid", "--json"}, root, env, ""), "invalid_request")

	file := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	broken := boardEnv(t, root)
	broken["HERDR_PLUGIN_STATE_DIR"] = file
	expectMachineError(t, runCLI([]string{"runs", "list", "--json"}, root, broken, ""), "history_unavailable")
	expectMachineError(t, runCLI([]string{"runs", "get", id, "--json"}, root, broken, ""), "history_unavailable")

	old := boardEnv(t, root)
	withHistoryDB(t, old["HERDR_PLUGIN_STATE_DIR"], func(db *sql.DB) {
		if _, err := db.Exec(`PRAGMA user_version = 7`); err != nil {
			t.Fatal(err)
		}
	})
	expectMachineError(t, runCLI([]string{"runs", "list", "--json"}, root, old, ""), "incompatible_history")
	expectMachineError(t, runCLI([]string{"runs", "get", id, "--json"}, root, old, ""), "incompatible_history")
	withHistoryDB(t, old["HERDR_PLUGIN_STATE_DIR"], func(db *sql.DB) {
		var version int
		if err := db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil || version != 7 {
			t.Fatalf("read migrated the database: version=%d err=%v", version, err)
		}
	})
}

func withHistoryDB(t *testing.T, stateDir string, fn func(*sql.DB)) {
	t.Helper()
	path := filepath.Join(stateDir, "history.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	fn(db)
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestRunsListWarnsOnMalformedAndOldRows(t *testing.T) {
	root := t.TempDir()
	writeWorkflow(t, root, "ok", "version: v1alpha1\nsteps:\n  - run: [\"true\"]\n")
	env := boardEnv(t, root)
	if got := runCLI([]string{"run", "ok"}, root, env, ""); got.code != 0 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	iso := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	withHistoryDB(t, env["HERDR_PLUGIN_STATE_DIR"], func(db *sql.DB) {
		for _, row := range []struct {
			version int
			blob    string
		}{{1, `{"version":1}`}, {1, `not json`}, {9, `{"version":9}`}} {
			if _, err := db.Exec(`INSERT INTO runs (id, version, expired, status, started_at, heartbeat_at, snapshot) VALUES (?, ?, 0, '', ?, ?, ?)`,
				history.AllocateRunID(), row.version, iso, iso, row.blob); err != nil {
				t.Fatal(err)
			}
		}
	})
	listed := decodeMachine(t, runCLI([]string{"runs", "list", "--json"}, root, env, ""))
	if !listed.OK || len(listed.Runs) != 1 || listed.Runs[0]["workflow"] != "ok" {
		t.Fatalf("list = %+v", listed)
	}
	counts := map[string]float64{}
	for _, w := range listed.Warnings {
		counts[w["code"].(string)] = w["count"].(float64)
	}
	if counts["malformed_run_skipped"] != 2 || counts["incompatible_run_skipped"] != 1 {
		t.Fatalf("warnings = %+v", listed.Warnings)
	}
}

func TestRunsListValidatesRequestFlags(t *testing.T) {
	root := t.TempDir()
	env := boardEnv(t, root)
	cases := [][]string{
		{"runs", "list", "--json", "--limit", "0"},
		{"runs", "list", "--json", "--limit", "201"},
		{"runs", "list", "--json", "--limit", "many"},
		{"runs", "list", "--json", "--cursor", "not-a-cursor"},
		{"runs", "list", "--json", "--status", "starting"},
		{"runs", "list", "--json", "--checkout-root", "relative/path"},
		{"runs", "list", "--json", "--bogus"},
		{"runs", "list", "--json", "extra"},
		{"runs", "get", "--json"},
	}
	for _, args := range cases {
		expectMachineError(t, runCLI(args, root, env, ""), "invalid_request")
	}
	plain := runCLI([]string{"runs", "list"}, root, env, "")
	if plain.code != 1 || plain.stdout != "" || !strings.Contains(plain.stderr, "requires --json") {
		t.Fatalf("no --json: code=%d stdout=%q stderr=%q", plain.code, plain.stdout, plain.stderr)
	}
	limit := decodeMachine(t, runCLI([]string{"runs", "list", "--json", "--limit", "200"}, root, env, ""))
	if !limit.OK {
		t.Fatalf("limit 200 = %+v", limit)
	}
}

func TestRunDetachAndJSONMustPair(t *testing.T) {
	root := t.TempDir()
	writeWorkflow(t, root, "hi", "version: v1alpha1\nsteps:\n  - run: [\"true\"]\n")
	env := boardEnv(t, root)
	for _, args := range [][]string{{"run", "hi", "--detach"}, {"run", "hi", "--json"}} {
		got := runCLI(args, root, env, "")
		if got.code != 1 || got.stdout != "" || !strings.Contains(got.stderr, "--detach and --json must be used together") {
			t.Fatalf("%v: code=%d stdout=%q stderr=%q", args, got.code, got.stdout, got.stderr)
		}
	}
	attached := runCLI([]string{"run", "hi"}, root, env, "")
	if attached.code != 0 || !strings.Contains(attached.stdout, "[1/1]") {
		t.Fatalf("attached run changed: code=%d stdout=%q stderr=%q", attached.code, attached.stdout, attached.stderr)
	}
}

func TestDetachedLaunchIsRejectedWithoutHistory(t *testing.T) {
	root := t.TempDir()
	sentinel := filepath.Join(root, "ran")
	writeWorkflow(t, root, "hi", fmt.Sprintf("version: v1alpha1\nsteps:\n  - run: [\"touch\", %q]\n", sentinel))
	file := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	env := boardEnv(t, root)
	env["HERDR_PLUGIN_STATE_DIR"] = file

	got := runCLI([]string{"run", "hi", "--detach", "--json", "--input", "a=hidden-value"}, root, env, "")
	out := expectMachineError(t, got, "launch_rejected")
	if strings.Contains(got.stdout+got.stderr, "hidden-value") {
		t.Fatalf("input leaked: %q %q", got.stdout, got.stderr)
	}
	if !strings.Contains(out.Error["message"].(string), "unavailable") {
		t.Fatalf("message = %v", out.Error)
	}
	time.Sleep(500 * time.Millisecond)
	if _, err := os.Stat(sentinel); err == nil {
		t.Fatal("child ran step 1 without a history record")
	}

	missing := runCLI([]string{"run", "nope", "--detach", "--json"}, root, boardEnv(t, root), "")
	expectMachineError(t, missing, "launch_rejected")
	secret := "private-workflow-name"
	rejected := runCLI([]string{"run", secret, "--detach", "--json"}, root, boardEnv(t, root), "")
	expectMachineError(t, rejected, "launch_rejected")
	if strings.Contains(rejected.stdout+rejected.stderr, secret) {
		t.Fatalf("child error leaked: %q %q", rejected.stdout, rejected.stderr)
	}
}

func TestLaunchPayloadRequireHistoryStopsBeforeStepOne(t *testing.T) {
	root := t.TempDir()
	sentinel := filepath.Join(root, "ran")
	writeWorkflow(t, root, "hi", fmt.Sprintf("version: v1alpha1\nsteps:\n  - run: [\"touch\", %q]\n", sentinel))
	file := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{
		"HOME":                      t.TempDir(),
		"HERDR_PLUGIN_CONFIG_DIR":   t.TempDir(),
		"HERDR_PLUGIN_STATE_DIR":    file,
		"HERDR_WORKFLOWS_REPO_ROOT": root,
	}
	required := runCLI([]string{"run", "hi", "--launch-payload"}, root, env, `{"name":"hi","inputs":{},"requireHistory":true}`)
	if required.code != 1 || !strings.Contains(required.stdout, "@hwf-history:unavailable") || !strings.Contains(required.stderr, "unavailable") {
		t.Fatalf("code=%d stdout=%q stderr=%q", required.code, required.stdout, required.stderr)
	}
	if _, err := os.Stat(sentinel); err == nil {
		t.Fatal("step 1 ran without history")
	}
	optional := runCLI([]string{"run", "hi", "--launch-payload"}, root, env, `{"name":"hi","inputs":{}}`)
	if optional.code != 0 {
		t.Fatalf("picker-style launch changed: code=%d stderr=%q", optional.code, optional.stderr)
	}
	if _, err := os.Stat(sentinel); err != nil {
		t.Fatal("picker-style launch no longer runs without history")
	}
}

func TestRunsHelpListsCommandsAndFlags(t *testing.T) {
	root := t.TempDir()
	got := runCLI([]string{"runs", "--help"}, root, nil, "")
	if got.code != 0 {
		t.Fatalf("code=%d stderr=%q", got.code, got.stderr)
	}
	for _, want := range []string{"list", "get"} {
		if !strings.Contains(got.stdout, want) {
			t.Fatalf("runs help lacks %q: %q", want, got.stdout)
		}
	}
	list := runCLI([]string{"runs", "list", "--help"}, root, nil, "")
	for _, want := range []string{"--json", "--checkout-root", "--status", "--limit", "--cursor", "succeeded"} {
		if !strings.Contains(list.stdout, want) {
			t.Fatalf("runs list help lacks %q: %q", want, list.stdout)
		}
	}
	run := runCLI([]string{"run", "--help"}, root, nil, "")
	for _, want := range []string{"--detach", "--json"} {
		if !strings.Contains(run.stdout, want) {
			t.Fatalf("run help lacks %q: %q", want, run.stdout)
		}
	}
}

func TestDetailErrorCodes(t *testing.T) {
	cases := map[string]string{
		"snapshot": "", "invalid": "invalid_request", "missing": "run_not_found",
		"expired": "run_not_found", "incompatible": "incompatible_history", "unavailable": "history_unavailable",
	}
	for kind, want := range cases {
		err := detailError(history.Detail{Kind: kind, Message: kind})
		if want == "" {
			if err != nil {
				t.Fatalf("%s: %v", kind, err)
			}
			continue
		}
		var machine *machineError
		if !errors.As(err, &machine) || machine.Code != want || machine.Message != kind {
			t.Fatalf("%s: %v", kind, err)
		}
	}
}
