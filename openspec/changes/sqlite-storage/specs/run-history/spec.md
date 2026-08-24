## MODIFIED Requirements

### Requirement: Snapshot replacement is recoverable and optional

The writer MUST maintain complete run state in memory and persist it to the global SQLite `history.db` in the plugin state directory. A failed history initialization or replacement MUST NOT fail or alter workflow execution. A later successful replacement MUST contain the complete latest state rather than depend on the failed write. Heartbeat refresh MUST update only the `heartbeat_at` column of that run's row. Old per-run JSON snapshot files MUST NOT be read, written, or migrated.

#### Scenario: Intermediate replacement fails

- **WHEN** one snapshot replacement fails and the next replacement succeeds
- **THEN** the readable snapshot contains the complete current run state

#### Scenario: Replacement finds no row

- **WHEN** a live run's row is no longer present and the writer replaces the snapshot
- **THEN** the row is written again with the complete current state, and a row already expired by retention stays expired

#### Scenario: History location is unavailable

- **WHEN** private run storage cannot be created or validated
- **THEN** the workflow continues and the caller can distinguish unavailable history from durable history

#### Scenario: Heartbeat does not rewrite the snapshot blob

- **WHEN** a live run refreshes its heartbeat
- **THEN** only that run's `heartbeat_at` column changes

### Requirement: Run storage and responses remain private

The plugin state directory and `history.db` MUST pass the existing private credential-store ownership and permission assertions. A permission mismatch MUST make history unavailable rather than weaken access checks. When the state root is a directory with permissive mode but no entries, the runner MUST tighten it to private (0700) and proceed. A non-empty permissive state root MUST make history unavailable. List MUST NOT run per-run file ACL checks.

#### Scenario: Run directory is group-readable

- **WHEN** a non-empty run-history state root has unsafe permissions
- **THEN** history is unavailable and the runner does not change the permissions silently

#### Scenario: Empty permissive state root

- **WHEN** the state root exists with permissive mode and contains no entries
- **THEN** the runner tightens it to private mode and history remains available

#### Scenario: Database file is group-readable

- **WHEN** `history.db` has unsafe permissions
- **THEN** history is unavailable and list does not present runs

### Requirement: Recent history is bounded after filtering

History projection MUST apply scope, status, and text predicates before sorting newest first and returning at most forty runs. The list MUST be an indexed SELECT of Summary columns and MUST NOT parse snapshot JSON. Terminal runs MUST share a fixed retention count of the last 50 terminal runs (code constant, not config). Cleanup MUST run only on creation and terminal persistence, expire oldest terminal runs first, and never expire an active or stale non-terminal run. An expired run MUST keep its identity row with snapshot and artifact blobs stripped so detail resolves as expired rather than unknown.

#### Scenario: Current run lies below foreign runs

- **WHEN** forty newer foreign-checkout runs precede a current-checkout run
- **THEN** Current can still return that run because scope is applied before the limit

#### Scenario: Cleanup sees active and terminal snapshots

- **WHEN** more than 50 terminal runs exist while active runs also exist
- **THEN** cleanup expires oldest terminal runs and preserves every non-terminal run

#### Scenario: Expired run remains resolvable

- **WHEN** a terminal run is expired by retention
- **THEN** opening that run id presents expired, not unknown

#### Scenario: Indexed list stays sub-second

- **WHEN** retained history is listed
- **THEN** the list path does not parse snapshot blobs and completes in less than one second on the profiled hardware class

#### Scenario: Newest record exceeds the target
- **WHEN** the newest terminal snapshot alone exceeds the byte target
- **THEN** it remains readable until a later terminal snapshot makes it eligible for oldest-first removal

### Requirement: Prior shared log is ignored

New runs MUST NOT write, read, migrate, or delete a prior shared `runs.jsonl` or leftover `*.json` snapshot files. History list and detail MUST use only `history.db`. Those leftover files on disk MUST NOT appear in Current or All.

#### Scenario: Shared log file remains on disk

- **WHEN** a prior `runs.jsonl` exists under plugin state
- **THEN** list and detail omit every row from that file and leave the file unchanged

#### Scenario: Leftover JSON snapshot remains on disk

- **WHEN** a prior per-run `*.json` snapshot exists under the old runs directory
- **THEN** list and detail omit it and leave the file unchanged

## ADDED Requirements

### Requirement: Debug artifacts are database blobs

Yaml-at-run and transcript debug payloads MUST be stored as artifact rows keyed by run id and kind in `history.db`. Write MUST apply the existing 8 MiB capture cap and MUST NOT truncate. Retention that expires a run MUST strip those blobs with the snapshot.

#### Scenario: Write under cap

- **WHEN** yaml-at-run text is under the capture cap
- **THEN** detail debug load returns that text

#### Scenario: Write over cap

- **WHEN** yaml-at-run text exceeds the capture cap
- **THEN** the write fails naming source and limit and stores nothing for that kind
