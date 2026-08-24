## 1. OpenSpec and driver

- [x] 1.1 Delta specs for `run-history`, `hwf-cli`, and new `scratchspace`
- [x] 1.2 Add `modernc.org/sqlite` v1.57.0 and pin `modernc.org/libc` to sqlite's go.mod version

## 2. SQLite history store

- [x] 2.1 Open `history.db` with busy_timeout before WAL, serialized first-touch, ACL on state dir + db
- [x] 2.2 `runs` / `artifacts` / `scratch` schema and Summary-column list SELECT
- [x] 2.3 Claim INSERT UNIQUE, heartbeat UPDATE, snapshot upsert, expired identity retention (50)
- [x] 2.4 Debug artifacts as blob rows with 8 MiB write caps
- [x] 2.5 Ignore leftover JSON / `runs.jsonl`. Keep Snapshot/Summary/Detail / Writer / ListRuns / RunDetail shapes

## 3. Scratch and panes

- [x] 3.1 Scratch get/set/list/delete in `internal/history` with 8 MiB write cap
- [x] 3.2 `hwf scratch` CLI (no Herdr preflight)
- [x] 3.3 Inject `HWF_RUN_ID`, `HWF_WORKFLOW`, `HWF_CHECKOUT_ROOT` into launched panes and local run env
- [x] 3.4 No `{{scratch.*}}` template root (existing loader rejection)

## 4. Tests and verify

- [x] 4.1 Update history tests off JSON files. Add UNIQUE claim, heartbeat, expired, scratch reap, and indexed list timing
- [x] 4.2 CLI scratch tests. Engine pane env test
- [x] 4.3 Docs CLI surface. `go tool verify`
