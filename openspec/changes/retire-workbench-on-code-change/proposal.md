## Why

An owned workbench process only stops on `SIGINT`/`SIGTERM`, so it outlives every rebuild and plugin upgrade. Because `picker-workbench-actions` reuses any endpoint that answers an authenticated probe, `Ctrl+E`/`Ctrl+Y`/`Ctrl+O` then adopt a server built from older code: a workbench started before a grammar change rejected valid workflow YAML with parse errors that named the file, and the only remedy was finding and killing the process by hand. Endpoint records are keyed on the canonical repository root alone (`hwf-cli`: "Web route and browser control"; `picker-workbench-actions`: "Workbench actions reuse a repository endpoint"), so nothing distinguishes a current server from a stale one.

## What Changes

- An owned workbench retires itself when the code it was built from changes: compiled installs watch the executable, dev runs watch the source tree.
- Retirement reuses the existing owned shutdown path, so the endpoint record is cleared and the next picker action starts a fresh workbench under the existing stale-endpoint rule.

## Capabilities

### Modified Capabilities

- `hwf-cli`: An owned workbench process stops on code change in addition to termination signals.

## Impact

Affects `src/tui/run-launch.ts` (watch helper) and `cmdWeb` in `src/cli.ts`, plus launch-helper tests. No workflow grammar, API route, endpoint record format, dependency, or picker behavior changes. `picker-workbench-actions` needs no amendment: a retired workbench cannot answer an authenticated probe, which its "Stale endpoint" scenario already covers.
