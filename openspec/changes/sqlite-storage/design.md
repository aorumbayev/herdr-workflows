## Context

Issues 50–53 decide storage, driver, scratch, and list cost. Surfaces keep consuming Snapshot / Summary / Detail. Only the engine under `internal/history` changes, plus CLI and pane env.

## Goals / Non-Goals

**Goals:**

- One global `history.db` in the plugin state dir (beside today's `runs/`).
- List via indexed Summary columns. Detail reads one snapshot blob.
- Claim INSERT UNIQUE. Heartbeat one-row UPDATE. Retention last 50 terminal runs with expired identity rows.
- Scratch KV in the same DB. `hwf scratch` verbs. Pane `HWF_RUN_ID` (workflow name, checkout root).
- cgo-free `modernc.org/sqlite` v1.57.0. DSN `busy_timeout` before `journal_mode(WAL)`. Serialized first-touch.

**Non-Goals:**

- No migration from JSON snapshots.
- No steps table. No `{{scratch.*}}`. No TTL/size config. No extra packages or store interfaces.
- Config stays profiles / transcripts only.

## Decisions

1. **Placement.** `history.db` is `$HERDR_PLUGIN_STATE_DIR/history.db`. ACL stays on the state dir and the db file (and WAL/SHM companions after create). Per-row ACL is gone — that was the list cost.
2. **Schema.** `runs` holds identity, Summary scalars (status, heartbeat_at, checkout_root, progress, current label, failure facts, step labels as JSON text for search), `expired`, snapshot version, snapshot blob. `artifacts(run_id, kind, body)`. `scratch(key, value, updated_at)`.
3. **List.** `SELECT` Summary columns `WHERE expired = 0` plus version filter. Scope/status/text still apply before the 40-row cap. Never unmarshal snapshot on the list path.
4. **Heartbeat.** Live `Touch` updates `heartbeat_at` only. Step/finalize writes still replace Summary columns and the snapshot blob.
5. **Retention.** On claim and terminal persist: among non-expired terminal rows, keep the newest 50 by `started_at` then id. Strip snapshot and artifacts, set `expired = 1`, `DELETE FROM scratch WHERE key LIKE '<id>.%'`. Live rows are never expired.
6. **Scratch keys.** The whole string is the key. Run-scoped convention is `<run-id>.…`. Unprefixed keys survive retention until `delete`.
7. **Pane env.** Inject `HWF_RUN_ID`, `HWF_WORKFLOW`, `HWF_CHECKOUT_ROOT` into env for placed `run:` and `agent:` panes (and local `run:` so a blocking `hwf scratch` step sees the same). Overlay after the generated input `HWF_*` cap so paths do not inflate that cap.
8. **Driver.** `database/sql` + `modernc.org/sqlite`. Package mutex serializes first open/migrate, the schema runs inside one `BEGIN IMMEDIATE` transaction on a dedicated connection that rolls back on failure (so a retry is not blocked by a stranded transaction), and open retries `SQLITE_BUSY`. The db path is percent-escaped into the `file:` URI so a `?`, `#`, or `%` in the state directory cannot move the file off the ACL-checked path.

## Risks / Trade-offs

- [WAL first-touch races] → mutex + busy_timeout-before-WAL + retry.
- [List still slow] → next step is index/query tuning, not TUI (issue 53).
- [Leftover JSON] → ignored. Operators lose pre-SQLite history (alpha).

## Migration Plan

Alpha: empty DB on first open. No JSON import. Rollback is revert.

## Open Questions

None from the issues. Unspecified details below are implementation choices, not spec forks:

- Scratch `list` prints keys, one per line, sorted.
- Scratch `get` missing key exits nonzero. `delete` missing key is success.
- Artifact kinds stay `entry.yaml` and `transcript`.
