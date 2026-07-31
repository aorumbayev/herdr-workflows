## Why

Runs become difficult to inspect after the picker closes because the TUI has no history browser and the workbench shows only terminal summaries. The prior shared `runs.jsonl` log lacked start events, active-step state, worktree identity, and safe structured failures, so it could not support trustworthy live status or exact worktree filtering. This change replaces that log with per-run snapshots. Old `runs.jsonl` files are ignored.

## What Changes

- Record each run in one private atomic snapshot with durable active-step state, exact checkout identity, safe step outcomes, and recorded coordination interruption.
- Add a Tab-switched Runs browser and scrollable run detail to the existing picker.
- Transition an executed workflow directly into `STARTING`, then attached live detail. retain terminal results and return to Runs on Escape while execution continues.
- Replace the workbench's flat Runs list with a location-filtered split inspector and guarded live refresh.
- Add authenticated `run=<uuid>` workbench deep links and a TUI `w` handoff.
- Expose only allowlisted run metadata plus an authenticated detail-only failure explanation. keep machine-wide scope temporary.
- Stop writing, reading, migrating, or deleting the prior shared `runs.jsonl`. Existing files may remain on disk and are ignored.
- Do not copy `.hwf` into new worktrees or add repository-family scope, cancellation, rerun, or raw-output browsing.

## Capabilities

### New Capabilities

- `run-history`: Atomic run records, active and terminal projection, exact worktree scope, safe list and detail data, and retention.

### Modified Capabilities

- `picker-presentation`: Add the Tab-switched Runs browser, run details, filtering, scope toggle, key handling, and empty states within the existing popup contract.
- `web-workbench-presentation`: Replace the flat Runs view with an accessible, responsive split inspector and location filtering.
- `hwf-cli`: Accept and preserve authenticated `run=<uuid>` workbench routes.

## Impact

- Run lifecycle and persistence in `src/history/`, `src/run/runner.ts`, and step execution.
- Picker state, rendering, launch handoff, and tests under `src/tui/`.
- Workbench API, routing, presentation, polling, and tests under `src/web/`.
- No compatibility path for existing `runs.jsonl` summaries.
- No new workflow syntax, external workflow engine, or third-party runtime dependency.
