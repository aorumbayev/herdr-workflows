# Tasks

Each task moves declarations verbatim and adds imports. No logic, constant, or message changes in any task.

## 1. Create the folder and the step-contract kernel

- [x] 1.1 Create `src/engine/` and move `src/engine.ts` to `src/engine/index.ts` with no content change
- [x] 1.2 Map the folder in `scripts/verify-layers.ts`: `moduleOf` returns `engine` for `src/engine/`, `ENTRIES.engine` becomes `src/engine/index.ts`, and the two `ALLOW` entries retarget to `src/engine/index.ts`
- [x] 1.3 Move the step contract into new `src/engine/contract.ts`: `StepFailure`, `StepOutcome`, `RunnerDeps`, `StepRunOpts`, `StepFrame`, `StepsResult`, `RunSteps`, `CoordinationError`, `isCoordinationError`, `errorText`, `readTruncated`, `dispatchFailure`, `runScratchDir`
- [x] 1.4 Add a `context:` comment in `src/engine/contract.ts` recording the cut order and that no file in the folder may import the orchestrator
- [x] 1.5 Run `bun test ./test` and `CI=1 npm run verify:layers`

## 2. Extract pane placement

- [x] 2.1 Move into new `src/engine/pane.ts`: `PlacedPane`, `PlaceAnchors`, `PlaceOpts`, `PaneInfoish`, `failPlacement`, `requireWorkspace`, `requireTargetPane`, `splitDirection`, `placedFrom`, `placeEmptyPane`, the layout readers (`LayoutNodeish`, `LayoutResult`, `createdPaneId`, `layoutPlacement`), `placeCommandPane`, `resolvePaneOpen`, `sizeToFirstRatio`, `quoteArgvForShell`, `quotePosixArg`
- [x] 2.2 Import from `./contract` only, and re-export from `src/engine/index.ts` whatever the tests and other modules already import from `./engine`
- [x] 2.3 Run `bun test ./test`

## 3. Extract command execution

- [x] 3.1 Move into new `src/engine/command.ts`: `CaptureBudget`, `readStreamAgainstBudget`, `shellArgv`, `killSpawn`, `CaptureResult`, `spawnCapture`, `CommandOutcome`, `captureResult`, `runShellStep`, `runArgvStep`, `buildHwfEnv`, `StepEnv`, `stepEnvValues`, `mergeStepEnv`, `commandArgv`, `bindCommandResult`, `commandFailure`, `localRun`, `placedRun`, `shellStep`, `herdrStep`, `RunAction`
- [x] 3.2 Import from `./contract` and `./pane` only
- [x] 3.3 Keep the `workflow/inputs.ts` dynamic-choice import of `spawnCapture` working through the `src/engine/index.ts` re-export
- [x] 3.4 Run `bun test ./test`

## 4. Extract the agent-turn mechanism

- [x] 4.1 Move into new `src/engine/agent-turn.ts`: the twelve turn constants (`TURN_TIMEOUT_MS` through `SUBMIT_RETRY_BACKOFF_MS`), `AgentAction`, `ManagedWaitMode`, `ProfileChoice`, `TurnWait`, `processInfoRecord`, `isAvailableShellProcessInfo`, `startAgentWhenShellReady`, `awaitAgentInteractiveReady`, `chooseProfile`, `normalizedPrefix`, `generateAgentName`, `managedResponsePath`, `managedPromptSpillPath`, `appendResponseInstruction`, `spilledPromptInstruction`, `readManagedResponse`, `responseDirOf`, `preparedResponsePath`, `fileHasText`, `missingManagedError`, `awaitManagedTurn`, `agentDetails`, `applyVerdict`, `managedResult`, `promptPickedUp`, `waitForPromptPickup`, `maybeSpillAgentPrompt`, `submitPrompt`, `closePane`, `placeNewAgentPane`, `bootNewAgent`, `newAgentTurn`, `targetTurn`, `agentStep`
- [x] 4.2 Import from `./contract` and `./pane` only, and confirm by reading the import block that nothing points at `./index`
- [x] 4.3 Re-export `generateAgentName` and `readManagedResponse` from `src/engine/index.ts` for their existing importers
- [x] 4.4 Run `bun test test/engine` then `bun test ./test`

## 5. Leave the orchestrator

- [x] 5.1 Confirm `src/engine/index.ts` holds only the orchestration and launch lifecycle: the step-runner table, `defaultDeps`, `fail`, `stepLabel`, `recordedOutcomeKind`, `progressOutcomeOf`, `bindResult`, `retryOf`, `failureOf`, `executeOnce`, `executeWithRetry`, `hardStepFailure`, `runSteps`, `runRecovery`, `finalizeEntryRun`, the workflow-step and child-run code, launch identity and payload, the detached run and web launchers, preflight, and `runWorkflow`
- [x] 5.2 Confirm each of the four files imports only files earlier in the cut order
- [x] 5.3 Confirm `bun run knip` reports no unused export introduced by the re-exports

## 6. Verification

- [x] 6.1 `bun test ./test`
- [x] 6.2 `CI=1 npm run verify`
- [x] 6.3 `bunx @fission-ai/openspec validate distill-agent-turn --strict`
- [x] 6.4 `bun run docs:build`
