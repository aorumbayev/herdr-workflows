# Tasks

Land `distill-agent-turn` first. Every task is a rename or a verbatim move, and each task ends green on its own.

## 1. Give `session` one meaning

- [ ] 1.1 Rename `RunsBrowserSession` to `RunsBrowserScreen` in `src/runs-browser.ts`, and rename the bare `session` parameter to `screen` in every function that takes it
- [ ] 1.2 Rename `PickerSessionOpts` to `PickerScreenOpts` and `runPickerSession` to `runPickerScreen` in `src/picker.ts`, updating the `src/cli.ts` caller
- [ ] 1.3 Rename `extractSessionTranscript` to `extractAgentTranscript` in `src/context.ts` and its caller
- [ ] 1.4 Confirm `InputSession`, `createInputSession`, and `syncInputSession` are unchanged, and that `agent_session` and `AgentSessionInfo` are unchanged
- [ ] 1.5 Run `bun test ./test` and `CI=1 npm run verify:check-types`

## 2. Give `target` one meaning

- [ ] 2.1 Rename `PlaceOpts.target` to `anchor` and `requireTargetPane` to `requireAnchorPane`, updating `placeEmptyPane` and `placeCommandPane` and the `sub(pane.target)` call sites that feed them
- [ ] 2.2 Confirm the `pane:` YAML key stays `target:` and that `PaneSpec.target` in `src/workflow/grammar.ts` is unchanged
- [ ] 2.3 Rename `CodeWatchTarget` to `CodeWatchPath` and `codeWatchTarget` to `codeWatchPath`, updating `retireOnCodeChange` and its tests
- [ ] 2.4 Rename `deleteTarget` to `pendingDelete` in `src/picker.ts`
- [ ] 2.5 Confirm every remaining `target` in engine code is a herdr agent selector
- [ ] 2.6 Run `bun test ./test`

## 3. Give `run` one meaning

- [ ] 3.1 Rename `RunAction` to `CommandAction`, `localRun` to `localCommand`, and `placedRun` to `placedCommand`
- [ ] 3.2 Leave `runShellStep`, `runArgvStep`, `runSteps`, `runWorkflow`, `runId`, `RunRecorder`, and `RunStepOutcomeKind` unchanged
- [ ] 3.3 Run `bun test test/engine`

## 4. Split the last two concerns out of `context.ts`

- [ ] 4.1 Move the caps cluster verbatim into new `src/caps.ts`: `CAPTURE_BYTE_LIMIT`, `HWF_ENV_BYTE_LIMIT`, `AGENT_PROMPT_BYTE_LIMIT`, `CaptureLimitError`, `assertUnderCaptureCap`, `assertUnderHwfEnvCap`, `assertHwfEnvValues`
- [ ] 4.2 Move the transcript cluster verbatim into new `src/transcript.ts`: `TranscriptExtractor`, `extractAgentTranscript`, `readClaudeTranscript`, `hasTranscriptSupport`, `transcriptText`
- [ ] 4.3 Update importers (`src/engine`, `src/history.ts`, `src/cli.ts`, `src/workflow/*`, `src/workbench.ts`) to import from the new modules
- [ ] 4.4 Add `caps` and `transcript` to the module map, layer table, and entry list in `scripts/verify-layers.ts`, and move the dynamic `engine` allowlist edge from `context.ts` to `transcript.ts`
- [ ] 4.5 Move the matching tests, updating import paths only
- [ ] 4.6 Confirm the caps documented in `AGENTS.md` and `CLAUDE.md` still name their home file correctly, and update that one sentence if it says `src/context.ts`
- [ ] 4.7 Run `bun test ./test` and `CI=1 npm run verify`

## 5. Verification

- [ ] 5.1 `bun test ./test`
- [ ] 5.2 `CI=1 npm run verify`
- [ ] 5.3 `bunx @fission-ai/openspec validate disambiguate-domain-nouns --strict`
- [ ] 5.4 `bun run docs:build`
