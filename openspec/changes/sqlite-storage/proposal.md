## Why

Run history today is one JSON file per run. Opening the runs list loads every file and runs a per-file ACL check. Profiling (issue 53) measured about 7 ms per file, 98% of that in `ls -le` ACL exec, so a few hundred runs take multiple seconds. JSON also forces a full rewrite on every 5s heartbeat and leaves sidecar artifacts that retention can orphan.

Issues 50–52 lock the replacement: one global SQLite `history.db`, cgo-free `modernc.org/sqlite`, a flat scratch key-value table in the same file, and no JSON migration (alpha break).

## What Changes

- **BREAKING:** private run history lives in one `history.db` in the plugin state dir. Per-run JSON snapshots, `.expired` tombstone files, and debug sidecars are abandoned with no migration.
- A `runs` table stores Summary columns plus a versioned snapshot JSON blob. There is no steps table. List is an indexed SELECT that never parses the blob.
- Debug artifacts are blob rows keyed by run id + kind. Caps stay 8 MiB at write.
- Claim is `INSERT` with UNIQUE run id (same rejected / unavailable semantics as `O_EXCL`). Heartbeat is one-row `UPDATE heartbeat_at`.
- Retention keeps the last 50 terminal runs (code constant). Expired rows keep identity with blobs stripped so detail still resolves as expired, not unknown. Prefixed scratch keys `run-id.*` are deleted with the run.
- WAL + `busy_timeout` before `journal_mode` in the DSN. First-touch WAL creation is serialized. Driver is `modernc.org/sqlite` v1.57.0 with `modernc.org/libc` pinned.
- Scratch is a flat `key` / `value` / `updated_at` table. CLI: `hwf scratch get|set|list|delete`. No `{{scratch.*}}` template root. Engine injects `HWF_RUN_ID` plus workflow name and checkout root into launched panes.

## Capabilities

### New Capabilities

- `scratchspace`: flat key-value store in `history.db`, CLI verbs, pane env, retention reaping of `<run-id>.*` keys.

### Modified Capabilities

- `run-history`: SQLite storage, claim/heartbeat/retention/artifact/privacy rules.
- `hwf-cli`: public `scratch` command surface. Scratch verbs skip Herdr preflight.

## Impact

- **Code:** `internal/history` storage engine, `internal/cli` scratch commands, `internal/engine` pane env, and tests that wrote JSON files.
- **Tests:** claim UNIQUE, heartbeat UPDATE, indexed list (sub-second), expired identity, scratch verbs/caps/reap, pane env, leftover JSON ignored.
- **Gates:** `go tool verify`. `openspec validate --all --strict`.
- **Dependencies:** add `modernc.org/sqlite` v1.57.0 and pin `modernc.org/libc`.
