# Proposal: simplify-module-interfaces

## Why

The repository exports roughly 230 public symbols from 48 source files, and the import graph connects every cluster to every other: three cross-cutting modules (`config`, `limits`, `session`) fan into everything, terminal I/O lives inside the socket client, launch plumbing lives inside the TUI, and three input collectors drift independently. The implementations are sound — the interfaces leaked. A three-way design review (minimal-interfaces, common-caller spine, ports & adapters) converged on the same fixes.

## What Changes

- Reshape the public surface into three layers — surfaces (`picker`, `workbench`), domain (`workflows`, `exchange`, `engine`, `history`), platform (`host`, `context`) — behind ~19 entry points. Arrows only point down.
- Move terminal I/O (`readLine`, `die`, `sanitizeDisplay`, `releaseStdinReader`, `tolerateClosedStdio`, `openInBrowser`) out of `src/herdr.ts` into a CLI-internal console module. `herdr.ts` becomes purely the socket seam.
- Move `src/tui/run-launch.ts` to `src/run/launch.ts`. Launching is engine business.
- Move dynamic-choice resolution from `workflow/load.ts` to `workflow/inputs.ts`. Merge the three input collectors into one `InputSession` state machine with three presentation adapters (CLI prompts, picker rows, web canvas).
- Move `run/recorder.ts` beside the history store. Recording becomes an invariant of `runWorkflow` rather than caller wiring. The ack codec goes private to `src/history/`.
- Collapse the history read path: `listRuns`/`runDetail` return presented blocks consumed identically by the runs browser and the web workbench.
- Seal the herdr seam behind stable `HerdrError` codes. Delete the `COORDINATION_PATTERNS` message-regex matching in `run/context.ts` (replaced by a stricter typed contract, never a weakened check).
- Resolve config once per process into a `loadContext()` result threaded down. Cap assertions live only at the four capture boundaries (herdr response capture, shell capture, dynamic-choice output, transcript read).
- Prune exports to the entry points. Exactly one file imports `@opentui/core`. Rename `ensureWorkbench` to `openWorkbench` returning a `WorkbenchHandle`.
- Explicitly rejected: fs/process/http/server/config/workflow-source ports (one adapter each — `test/setup.ts` environment substitution is already the second adapter). An in-memory history fake (mode-bit and claim-race semantics are the product). Splitting `parse.ts` (deferred until the complexity gate pinches).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `step-control-flow`: coordination loss MUST be identified by the socket client's stable error codes, never by matching error message text. This is the one spec-level tightening. Every other observable contract (workflow grammar, CLI argv, picker behavior, workbench routes, run history semantics, caps) is unchanged, and the full gate set is the oracle after every move.

## Impact

- **Code:** most files under `src/` are touched for imports/exports. File moves listed above. No file merges (the complexity gate scores whole-file SLOC). `src/workflow/parse.ts` must not grow.
- **Tests:** the suite is the behavioral oracle and stays green after every move. Tests that imported now-internal helpers re-point to internal-seam imports. Inline `RunnerDeps` fakes may consolidate.
- **Gates:** `bun test ./test`, `CI=1 npm run verify`, `bun run docs:build`, `openspec validate --all --strict` after each move. Knip reachability holds because every entry file is on the `cli.ts` graph.
- **Dependencies:** none added or removed.
