## Why

`src/engine.ts` is 2,210 lines and holds five unrelated concerns: the step contract, pane placement, local command capture, the agent-turn mechanism, and the detached-launch lifecycle. A reader who wants one of them reads all five.

The agent-turn mechanism is the sharpest case. It is about 470 lines (`engine.ts:800-1268`) of settle-loop, submit-retry, pickup-detection, and verdict-gate logic with twelve tuning constants. It is the part most likely to change, the part hardest to reason about, and the part a maintainer most needs to hold in their head alone.

The prior `refactor-language-and-cohesion` change tried this extraction as one task and reverted it. The recorded reason was that the region needs about ten engine-internal helpers, so moving it alone forces the new module to import from `engine.ts` while `engine.ts` imports the new module back. That finding is correct and is confirmed here by direct reading. It rules out the naive one-file extraction. It does not rule out the extraction.

## What Changes

The mechanism is not the problem. The cut order is. Extracting the top of the call graph first is what creates the cycle. Cutting bottom-up, in dependency order, produces no cycle at all.

`src/engine.ts` becomes `src/engine/`, an internal folder with one entry, cut in this order:

1. `src/engine/contract.ts` — the step-contract kernel: `StepFailure`, `StepOutcome`, `RunnerDeps`, `StepRunOpts`, `StepFrame`, `StepsResult`, `RunSteps`, `CoordinationError`, `isCoordinationError`, `errorText`, `dispatchFailure`, `readTruncated`. Depends only on `context`, `history`, `host`, and `workflows`. Imports nothing from its siblings.
2. `src/engine/pane.ts` — placement: `PlacedPane`, `PlaceOpts`, `placeEmptyPane`, `placeCommandPane`, `resolvePaneOpen`, `sizeToFirstRatio`, `quoteArgvForShell`, `quotePosixArg`, and the layout readers. Imports `contract` only. Serves both the `run` and `agent` actions, so it is a genuine shared concern rather than a leftover.
3. `src/engine/command.ts` — local and placed command execution: `spawnCapture`, `shellArgv`, `killSpawn`, the capture budget, `captureResult`, the step-env helpers, `localRun`, `placedRun`, `shellStep`, `herdrStep`. Imports `contract` and `pane`.
4. `src/engine/agent-turn.ts` — the mechanism, moved verbatim: the twelve constants, `startAgentWhenShellReady`, `awaitAgentInteractiveReady`, `chooseProfile`, the managed-response path helpers, `awaitManagedTurn`, `applyVerdict`, `managedResult`, `promptPickedUp`, `waitForPromptPickup`, `maybeSpillAgentPrompt`, `submitPrompt`, `placeNewAgentPane`, `bootNewAgent`, `newAgentTurn`, `targetTurn`, `agentStep`, `generateAgentName`, `readManagedResponse`. Imports `contract` and `pane`.
5. `src/engine/index.ts` — the orchestrator and the module's only entry: the step-runner table, retry and failure handling, `runSteps`, recovery, preflight, launch identity and payload, the detached run and web launchers, and `runWorkflow`. Imports the four files. Nothing imports it back.

Every import points one way. There is no cycle to justify.

The move is verbatim. No logic is rewritten, no constant retuned, no error message reworded.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. The change is behavior-neutral: file moves plus import rewrites, with no change to the YAML grammar, the CLI, or any observable workflow behavior. `.openspec.yaml` sets `skip_specs: true`.

## Impact

- Code: `src/engine.ts` is replaced by `src/engine/` (`contract.ts`, `pane.ts`, `command.ts`, `agent-turn.ts`, `index.ts`).
- Layers: `scripts/verify-layers.ts` maps `src/engine/` to the `engine` module and sets the entry to `src/engine/index.ts`. Intra-module edges are unrestricted by design, so the internal cut needs no new allowlist entry. The two dynamic allowlist edges (`context.ts -> src/engine.ts` and `workflow/inputs.ts -> src/engine.ts`) retarget to the new entry path.
- Tests: `test/engine/*` update import paths only. Assertions do not change.
- Compatibility: no public surface, no grammar, no CLI, and no spec behavior change.
- Not a line-budget split. `engine.ts` is 2,210 lines against a 2,500-line gate, so the file would pass untouched. The reason to cut is model clarity.
