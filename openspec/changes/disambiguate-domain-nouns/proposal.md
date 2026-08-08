## Why

The `refactor-language-and-cohesion` change fixed the `token` false cognate and the `StepCtx` alias, and deferred the rest. Three nouns still carry several unrelated meanings each, and one file still bundles unrelated concerns. A single maintainer pays for this on every read: the word tells you nothing, so you open the definition.

Counts below are from direct reading, not estimates.

- **`session`** carries four meanings. A runs-browser screen's live state (`RunsBrowserSession`, `runs-browser.ts:274`, plus a bare `session` parameter in about thirty functions). A picker screen's lifetime (`PickerSessionOpts` / `runPickerSession`, `picker.ts:1169`). An interactive question-and-answer episode (`InputSession` / `createInputSession`, `workflow/inputs.ts`). A Claude agent conversation (`agent_session`, from the herdr API).
- **`target`** carries four meanings. A herdr agent selector (`AgentAction.target`, `grammar.ts:64`). A placement anchor pane, tab, or workspace (`PaneSpec.target`, `grammar.ts:88`, and `PlaceOpts.target` / `requireTargetPane`, `engine.ts:281` and `engine.ts:304`). A filesystem path to watch for a code change (`CodeWatchTarget` / `codeWatchTarget`, `engine.ts:1428`). The workflow a picker delete prompt is about (`deleteTarget`, `picker.ts:140`).
- **`run`** carries two meanings on the same hot path. A workflow execution (`runId`, `RunRecorder`, `RunStepOutcomeKind`, `runSteps`, `runWorkflow`) and the `run:` step action, which is a shell or argv command (`RunAction`, `localRun`, `placedRun`).
- **`context.ts`** is 593 lines and still bundles four concerns after the credential extraction: product metadata and browser opening, the latest-wins generation token, the byte caps, the config layers and invocation context, and transcript extraction.

## What Changes

Renames are by sense, not by prefix. Each noun keeps exactly one meaning, and every other sense gets a word that already reads correctly in this domain.

`session` keeps one meaning: an interactive question-and-answer episode, which is `InputSession`.

- `RunsBrowserSession` becomes `RunsBrowserScreen`, and the bare `session` parameter throughout `runs-browser.ts` becomes `screen`.
- `PickerSessionOpts` / `runPickerSession` become `PickerScreenOpts` / `runPickerScreen`.
- `extractSessionTranscript` becomes `extractAgentTranscript`, which is what it does.
- `agent_session` and `AgentSessionInfo` are unchanged. They are herdr's words for herdr's concept, and the anticorruption layer exists so herdr's vocabulary stays visible at the boundary.

`target` keeps one meaning: a herdr agent selector.

- `PlaceOpts.target` becomes `anchor`, and `requireTargetPane` becomes `requireAnchorPane`. The `pane:` YAML key stays `target:`.
- `CodeWatchTarget` / `codeWatchTarget` become `CodeWatchPath` / `codeWatchPath`.
- `deleteTarget` becomes `pendingDelete`.

`run` keeps one meaning: a workflow execution. The `run:` action's code says command.

- `RunAction` becomes `CommandAction`, `localRun` becomes `localCommand`, `placedRun` becomes `placedCommand`.
- `runShellStep` and `runArgvStep` are unchanged. They read as "run a step", which is the workflow-execution sense, so they are already correct.

`context.ts` gives up its last two unrelated concerns, following the pattern the credential extraction established.

- New `src/caps.ts` holds the byte caps and their guards: `CAPTURE_BYTE_LIMIT`, `HWF_ENV_BYTE_LIMIT`, `AGENT_PROMPT_BYTE_LIMIT`, `CaptureLimitError`, `assertUnderCaptureCap`, `assertUnderHwfEnvCap`, `assertHwfEnvValues`.
- New `src/transcript.ts` holds transcript extraction: `TranscriptExtractor`, `extractAgentTranscript`, `readClaudeTranscript`, `hasTranscriptSupport`, `transcriptText`.
- `context.ts` keeps product metadata, the generation token, the config layers, and the invocation context.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. Every change is a rename or a verbatim move. No YAML key, CLI flag, config key, history field, or error message changes. `.openspec.yaml` sets `skip_specs: true`.

## Impact

- Code: `src/runs-browser.ts`, `src/picker.ts`, `src/engine/` (or `src/engine.ts` if this lands first), `src/context.ts`, plus new `src/caps.ts` and `src/transcript.ts`.
- Layers: `scripts/verify-layers.ts` gains `caps` and `transcript` in the platform layer with their own entries. The dynamic `context.ts -> engine` allowlist edge moves to `transcript.ts -> engine`, because the transcript command is what needs `spawnCapture`.
- Tests: import paths and local identifier names update. No assertion changes meaning.
- Sequencing: land `distill-agent-turn` first. It moves much of the same `engine.ts` code, and doing the renames first would guarantee a conflict on every moved line.
- Docs: no user-facing prose changes, because no user-facing name changes.
