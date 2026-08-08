# Tasks

Land `distill-agent-turn` first. Every task is a rename or a verbatim move, and each task ends green on its own.

## 1. Give `session` one meaning

- [x] 1.1 Rename `RunsBrowserSession` to `RunsBrowserScreen` in `src/runs-browser.ts`, and rename the bare `session` parameter to `screen` in every function that takes it
- [x] 1.2 Rename `PickerSessionOpts` to `PickerScreenOpts` and `runPickerSession` to `runPickerScreen` in `src/picker.ts`, updating the `src/cli.ts` caller
- [x] 1.3 Rename `extractSessionTranscript` to `extractAgentTranscript` in `src/context.ts` and its caller
- [x] 1.4 Confirm `InputSession`, `createInputSession`, and `syncInputSession` are unchanged, and that `agent_session` and `AgentSessionInfo` are unchanged (task 5.1 removes the last other sense)
- [x] 1.5 Run `bun test ./test` and `CI=1 npm run verify:check-types`

## 2. Give `target` one meaning

- [x] 2.1 Rename `PlaceOpts.target` to `anchor` and `requireTargetPane` to `requireAnchorPane`, updating `placeEmptyPane` and `placeCommandPane` and the `sub(pane.target)` call sites that feed them
- [x] 2.2 Confirm the `pane:` YAML key stays `target:` (task 5.4 renames the private `PaneSpec.target` field behind it)
- [x] 2.3 Rename `CodeWatchTarget` to `CodeWatchPath` and `codeWatchTarget` to `codeWatchPath`, updating `retireOnCodeChange` and its tests
- [x] 2.4 Rename `deleteTarget` to `pendingDelete` in `src/picker.ts`
- [x] 2.5 Confirm every remaining `target` in engine code is a herdr agent selector, herdr's `target_pane_id`, or a read of the YAML `pane.target` key (completed by task 5.2)
- [x] 2.6 Run `bun test ./test`

## 3. Give `run` one meaning

- [x] 3.1 Rename `RunAction` to `CommandAction`, `localRun` to `localCommand`, and `placedRun` to `placedCommand`
- [x] 3.2 Leave `runShellStep`, `runArgvStep`, `runSteps`, `runWorkflow`, `runId`, `RunRecorder`, and `RunStepOutcomeKind` unchanged
- [x] 3.3 Run `bun test test/engine`

## 4. Split the last two concerns out of `context.ts`

- [x] 4.1 Move the caps cluster verbatim into new `src/caps.ts`: `CAPTURE_BYTE_LIMIT`, `HWF_ENV_BYTE_LIMIT`, `AGENT_PROMPT_BYTE_LIMIT`, `CaptureLimitError`, `assertUnderCaptureCap`, `assertUnderHwfEnvCap`, `assertHwfEnvValues`
- [x] 4.2 Move the transcript cluster verbatim into new `src/transcript.ts`: `extractAgentTranscript`, `readClaudeTranscript`, `hasTranscriptSupport`, `transcriptText`. `TranscriptExtractor` stays in `src/context.ts` beside `transcriptSchema` (task 5.6)
- [x] 4.3 Update importers (`src/engine`, `src/history.ts`, `src/cli.ts`, `src/workflow/*`, `src/workbench.ts`) to import from the new modules
- [x] 4.4 Add `caps` and `transcript` to the module map, layer table, and entry list in `scripts/verify-layers.ts`, and move the dynamic `engine` allowlist edge from `context.ts` to `transcript.ts`
- [x] 4.5 Move the matching tests, updating import paths only
- [x] 4.6 Confirm the caps documented in `AGENTS.md` and `CLAUDE.md` still name their home file correctly, and update that one sentence if it says `src/context.ts`
- [x] 4.7 Run `bun test ./test` and `CI=1 npm run verify`

## 5. Close the review findings

- [x] 5.1 Rename `RunHistorySession` to `RunHistoryWriter` in `src/history.ts` and its bare `session` locals to `writer`, updating the test consumers. `RunRecorder` / `createRunRecorder` stay
- [x] 5.2 Rename the three remaining non-selector `target` identifiers: the referenced-input name in `src/workflow/validate.ts` to `referencedInput`, the snapshot path in `src/history.ts` to `path`, and the symlink destination in `src/cli.ts` to `linkDest`. Every message string stays byte-identical
- [x] 5.3 Rename the private `RunAction` in `src/workflow/grammar.ts` to `CommandAction`, matching the engine's copy
- [x] 5.4 Rename `PaneSpec.target` to `anchor` in `src/workflow/grammar.ts`, keep `parsePane` reading the YAML key `target:`, and update the `pane.anchor` reads in `src/engine/command.ts`, `src/engine/agent-turn.ts`, and `src/workflow/validate.ts`
- [x] 5.5 Rename `retireOnCodeChange`'s parameter `watched` to `path` in `src/engine/index.ts`
- [x] 5.6 Move `TranscriptExtractor` back to `src/context.ts` beside `transcriptSchema`, import it into `src/transcript.ts` and `src/engine/contract.ts`, and replace `context->transcript` with `transcript->context` in `scripts/verify-layers.ts`
- [x] 5.7 Reword the `formatHwfEnvBlock` JSDoc in `src/caps.ts` so it says the function models the block's size for the cap check, and names `buildHwfEnv` as the real builder
- [x] 5.8 Correct the noun counts and the changed-item lists in `proposal.md`, add D7 and D8 to `design.md`, and match the `AGENTS.md` module-layers line to `scripts/verify-layers.ts`

## 6. Verification

- [x] 6.1 `bun test ./test`
- [x] 6.2 `CI=1 npm run verify`
- [x] 6.3 `bunx tsc --noEmit`
- [x] 6.4 `bun run build`
- [x] 6.5 `bunx @fission-ai/openspec validate disambiguate-domain-nouns --strict`
- [x] 6.6 `bun run docs:build`
