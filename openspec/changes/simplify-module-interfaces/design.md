# Design: simplify-module-interfaces

## Context

48 source files export ~230 public symbols. Interfaces leaked in four ways: the socket client (`src/herdr.ts`) hosts terminal I/O. Launch identity and payload plumbing (`src/tui/run-launch.ts`) live in the TUI though `cli.ts` consumes them headlessly. Three input collectors (`collectInputValues`, `collectWorkflowInputs`, `createInputSession`) shadow one contract across three surfaces. The history read path is assembled twice (`runs-browser.ts` and `web/server.ts` each combine `toDetail` + presentation helpers). Cross-cutting modules (`config`, `limits`, `session`) are imported ad hoc everywhere, which is why the module graph is unreadable.

Constraints that shape everything: the complexity gate scores each function against its whole file's SLOC (threshold 12. `parse.ts` sits at 13.0), so file merges are forbidden and depth must come from directories behind one entry file. Knip requires reachability from `cli.ts`. Comments more than 2 lines fail unless JSDoc or `context:`. No new dependencies. Grammar dies at load. Never weaken a check.

## Goals / Non-Goals

**Goals:**

- Three layers (surfaces → domain → platform) with ~19 public entry points. Imports only point down.
- One input-collection state machine with three presentation adapters.
- Typed `HerdrError` codes as the only coordination-loss contract.
- Config resolved once per process. Cap assertions only at the four capture boundaries.
- Every move lands with the full gate set green. Behavior is bit-for-bit identical.

**Non-Goals:**

- No spec-level behavior change of any kind (no delta specs).
- No file merges. No `parse.ts` split (deferred until the gate pinches).
- No new ports: fs, process, http, server, config, workflow-source stay direct calls (`test/setup.ts` environment substitution is the second adapter already).
- No in-memory history fake. The fs store's mode-bit and claim-race semantics are the product.
- No behavior-preserving rewrites of file bodies that moves do not require.

## Decisions

1. **Depth = directory behind one entry file, not one big file.** The gate punishes large files. AGENTS.md punishes file sprawl. The unit of design is therefore the directory (`src/workflow/` behind `load.ts` + `inputs.ts` + `types.ts`, `src/run/` behind `runner.ts` + `launch.ts`, `src/history/` behind its read/write entries). Alternative — merging files into deep single-file modules — rejected: sinks complexity scores.
2. **Terminal I/O leaves `herdr.ts` into a CLI-internal console module** (new file, reachable from `cli.ts`). Alternative — leave it and re-export — rejected: it is why `runs-browser.ts` imports `sanitizeDisplay` from the socket client.
3. **`run-launch.ts` → `src/run/launch.ts`.** Launch identity, payload codec, retire-on-code-change are engine concerns. `cli.ts` already imports them for headless launches, proving they are not TUI. All three independent designs converged here.
4. **One `InputSession`.** Dynamic-choice resolution moves from `load.ts` to `inputs.ts` (collection-time per the hard constraint: options resolve during collection or picker, never at load. Detached payloads must NOT live-resolve). The headless CLI collector becomes a small internal driver over the session. Picker and web field submission are the other two adapters. Alternative — keep three collectors and document drift — rejected: "add an input type" is currently three-surface archaeology.
5. **Recorder moves beside the store. Recording becomes an invariant of `runWorkflow`.** The ack codec (`formatHistoryAck`/`parseHistoryAck`) goes private to `src/history/`. The runner keeps a `RunRecorder` handle as an internal test seam, not a public type. Alternative — pluggable history backends — rejected: one adapter, hypothetical seam.
6. **History read path returns presented blocks.** `listRuns(filter)` / `runDetail(id)` absorb projection plus presentation. The runs browser and workbench render the same blocks. Alternative — shared helper library both surfaces compose — rejected: that is the current shape and it drifted.
7. **Seal the herdr seam with error codes.** The production adapter guarantees `HerdrError{code}` for every failure (transport loss is exactly `closed | no_socket | unreachable`). `isCoordinationError` becomes a pure code check and `COORDINATION_PATTERNS` is deleted. This deletes defensive logic only because a stricter typed contract replaces it, pinned by tests at the seam. Alternative — keep regexes as belt-and-braces — rejected: two sources of truth for one contract.
8. **`loadContext()` one-call.** Config layers + repo root + invocation context + platform + base template namespace resolve once in `cli.ts` and thread down as a value. `buildTemplateNamespace` moves to `src/workflow/` where the template contract lives. Alternative — module-level singletons — rejected: hides the dependency and breaks test isolation.
9. **Rename `ensureWorkbench` → `openWorkbench` returning `WorkbenchHandle`.** "Open" carries get-a-handle-whether-or-not-it-exists semantics (adopt-or-start) in the user's own verb. Replace means remove: no alias export.
10. **Export pruning is the last move, mechanical, gated by knip.** Tests that imported now-internal helpers re-point to direct internal-file imports (declared internal seams) or move to the entry-point surface. `@opentui/core` ends with exactly one importer (`picker-chrome.ts` via a `mountChrome` factory and re-exported `ChromeKeyEvent`/`ChromeOption` aliases).

## Risks / Trade-offs

- [Detached `--launch-payload` runs regress when dynamic-choice resolution moves] → the existing detached-run tests are the oracle and must not be rewritten during the move. The domain-snapshot invariant text moves with the code.
- [Deleting `COORDINATION_PATTERNS` misses an error shape the regexes caught] → seal the adapter first, add seam tests that inject each coordination code, only then delete the regexes. A raw non-`HerdrError` escaping the port is a bug the new contract makes loud.
- [The `InputSession` interface bends to one surface's needs (web push semantics)] → the session stays a presentation-free state machine emitting effect requests. Adapters own presentation.
- [Export pruning churns test imports broadly] → mechanical, done last, one commit. The quarantine preload and `RunnerDeps` already carry test isolation.
- [Complexity gate movement from file shrink/growth] → layout moves shrink or hold the touched files. `verify:complexity` runs after each task.

## Migration Plan

Execute tasks in order. After every task run `bun test ./test` and `CI=1 npm run verify` (plus `docs:build` and `openspec validate --all --strict` at milestones). Each task is a self-contained commit candidate. Abort-and-revert is per-task. No data, schema, or config migration — purely source moves and export changes.
