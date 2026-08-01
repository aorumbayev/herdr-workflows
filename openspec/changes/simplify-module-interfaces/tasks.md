# Tasks: simplify-module-interfaces

Run `bun test ./test` and `CI=1 npm run verify` after every task. Both must be green before the next task starts. Run `bun run docs:build` and `openspec validate --all --strict` after tasks 2.3, 4.2, and 6.3. Never grow `src/workflow/parse.ts`.

## 1. Platform seams

- [x] 1.1 Move terminal I/O out of `src/herdr.ts` into a CLI-internal console module (`readLine`, `releaseStdinReader`, `sanitizeDisplay`, `die`, `tolerateClosedStdio`, `openInBrowser`). Re-point `cli.ts`, `tui/*`, and any other importers. `herdr.ts` keeps only socket RPC, CLI wrappers, protocol check, and `HerdrError`.
- [x] 1.2 Guarantee every failure leaving `herdr.ts` is a `HerdrError` with a stable code. Transport loss is exactly `closed | no_socket | unreachable`. Add seam tests injecting each transport-loss code through `RunnerDeps`.
- [x] 1.3 Delete `COORDINATION_PATTERNS` and the message-regex fallback in `run/context.ts`. `isCoordinationError` becomes a pure code check. Existing coordination tests must still pass unmodified. The new seam tests from 1.2 are the added pins.

## 2. Engine and history seams

- [x] 2.1 Move `src/tui/run-launch.ts` to `src/run/launch.ts`. Update `cli.ts` and picker imports. No behavior change.
- [x] 2.2 Move `src/run/recorder.ts` to `src/history/recorder.ts`. Make the ack codec (`formatHistoryAck`/`parseHistoryAck`) private to `src/history/`. Wire recording as an invariant inside `runWorkflow` (callers stop constructing the recorder. The runner accepts an internal test seam handle).
- [x] 2.3 Collapse the history read path: `listRuns(filter)` and `runDetail(id)` in `src/history/` return presented blocks. `tui/runs-browser.ts` and `web/server.ts` consume the same blocks. `project.ts` presentation helpers go internal.

## 3. One input session

- [x] 3.1 Move dynamic-choice resolution (`resolveDynamicChoices`, stdout parsing, caps) from `workflow/load.ts` to `workflow/inputs.ts`. Loading never resolves options. Detached payload replay keeps rejecting live resolution. Detached-run tests are the oracle and must not be rewritten.
- [x] 3.2 Merge `collectInputValues` / `collectWorkflowInputs` into `createInputSession`. The headless CLI collector becomes an internal driver over the session. The picker consumes the session as an adapter. Web field submission reaches the session only via `hwf run` (no direct web adapter).

## 4. Context and caps

- [x] 4.1 Introduce `loadContext()` in `src/config.ts` returning config layers + repo root + invocation context + platform + base namespace in one call. `cli.ts` resolves it once and threads it down. Surfaces stop calling `loadConfig`/`readInvocationContext`/`platformName` piecemeal.
- [x] 4.2 Move `buildTemplateNamespace` from `config.ts` to `src/workflow/`. Cap assertions (`assertUnder*`) fire at the capture boundaries (herdr response, shell, dynamic-choice output, transcript) and at the other sized-payload gates that also cross the shared byte cap (workflow import YAML, share bundle JSON, agent prompt before spill).

## 5. Surface entry points

- [x] 5.1 Close the `@opentui/core` leak: `picker-chrome.ts` exports a `mountChrome` factory owning `createCliRenderer`, plus `ChromeKeyEvent`/`ChromeOption` aliases. `picker.ts` and `runs-browser.ts` drop their direct toolkit imports. Exactly one file imports `@opentui/core`.
- [x] 5.2 Rename `ensureWorkbench` to `openWorkbench` returning `WorkbenchHandle` (rename `EnsuredWorkbench`). No alias export. Update all call sites and tests.
- [x] 5.3 Fold `runInit`/`runUpdate`/`runSetup` module boundaries into `cli.ts` subcommand internals (files stay. Exports shrink to what cli.ts consumes).

## 6. Export pruning

- [x] 6.1 Prune `src/tui/picker.ts` exports to the picker entry. Tests re-point to internal-seam imports where needed.
- [x] 6.2 Prune `src/run/context.ts`, `src/history/*`, `src/web/*`, and `src/workflow/*` exports to the entry points named in design.md. Knip must stay green.
- [x] 6.3 Sweep: confirm the layer rule (surfaces → domain → platform, no upward or sideways imports beyond `engine → history` and `exchange → workflows`). Run the full gate set including `bun run schema && bun run examples` regeneration check (zero-byte diff).
