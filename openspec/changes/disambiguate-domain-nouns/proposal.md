## Why

The `refactor-language-and-cohesion` change fixed the `token` false cognate and the `StepCtx` alias, and deferred the rest. Three nouns still carry several unrelated meanings each, and one file still bundles unrelated concerns. A single maintainer pays for this on every read: the word tells you nothing, so you open the definition.

Counts below are from direct reading, not estimates.

- **`session`** carries five meanings. A runs-browser screen's live state (`RunsBrowserSession`, `runs-browser.ts:274`, plus a bare `session` parameter in about thirty functions). A picker screen's lifetime (`PickerSessionOpts` / `runPickerSession`, `picker.ts:1169`). An interactive question-and-answer episode (`InputSession` / `createInputSession`, `workflow/inputs.ts`). A stateful handle that claims a run's history record, heartbeats it, records steps, and finalizes it (`RunHistorySession`, `history.ts:867`, plus about fourteen bare `session` locals in `makeRecorder` and `createRunRecorder`). A Claude agent conversation (`agent_session`, from the herdr API).
- **`target`** carries six meanings. A herdr agent selector (`AgentAction.target`, `grammar.ts:88`). A placement anchor pane, tab, or workspace (`PaneSpec.target`, `grammar.ts:64`, and `PlaceOpts.target` / `requireTargetPane`, `engine.ts:281` and `engine.ts:304`). A filesystem path to watch for a code change (`CodeWatchTarget` / `codeWatchTarget`, `engine.ts:1428`). The workflow a picker delete prompt is about (`deleteTarget`, `picker.ts:140`). A destination path on disk (the snapshot path in `writeSnapshotAtomic`, `history.ts:779`, and the symlink destination in `cli.ts:260`). The name of an input that a template path references (about ten sites in `workflow/validate.ts`, around lines 715 and 751).
- **`run`** carries two meanings on the same hot path. A workflow execution (`runId`, `RunRecorder`, `RunStepOutcomeKind`, `runSteps`, `runWorkflow`) and the `run:` step action, which is a shell or argv command (`RunAction`, `localRun`, `placedRun`).
- **`context.ts`** is 593 lines and still bundles four concerns after the credential extraction: product metadata and browser opening, the latest-wins generation token, the byte caps, the config layers and invocation context, and transcript extraction.

## What Changes

Renames are by sense, not by prefix. Each noun keeps exactly one meaning, and every other sense gets a word that already reads correctly in this domain.

`session` keeps one meaning: an interactive question-and-answer episode, which is `InputSession`.

- `RunsBrowserSession` becomes `RunsBrowserScreen`, and the bare `session` parameter throughout `runs-browser.ts` becomes `screen`.
- `PickerSessionOpts` / `runPickerSession` become `PickerScreenOpts` / `runPickerScreen`.
- `extractSessionTranscript` becomes `extractAgentTranscript`, which is what it does.
- `RunHistorySession` becomes `RunHistoryWriter`, and the bare `session` locals that hold one become `writer`. `RunRecorder` / `createRunRecorder` are a different thing and keep their names: the recorder is the narrow interface the engine calls, and the writer is the handle that owns the claim.
- `agent_session` and `AgentSessionInfo` are unchanged. They are herdr's words for herdr's concept, and the anticorruption layer exists so herdr's vocabulary stays visible at the boundary.

`target` keeps one meaning: a herdr agent selector.

- `PlaceOpts.target` becomes `anchor`, and `requireTargetPane` becomes `requireAnchorPane`. The `pane:` YAML key stays `target:`.
- `PaneSpec.target` becomes `anchor`. This is now in scope, because `PaneSpec` is a private hand-written type rather than a `z.infer` of the schema, and `parsePane` maps the schema onto it. The mapping line becomes `anchor: raw.target`, so the YAML key, the Zod schema, `docs/workflow.schema.json`, and every message that names `pane.target` are all unaffected.
- `CodeWatchTarget` / `codeWatchTarget` become `CodeWatchPath` / `codeWatchPath`, and `retireOnCodeChange`'s parameter becomes `path`, because `watched` reads as a boolean.
- `deleteTarget` becomes `pendingDelete`.
- The snapshot path in `writeSnapshotAtomic` becomes `path`, and the symlink destination in `cli.ts` becomes `linkDest`.
- The referenced-input name in `workflow/validate.ts` becomes `referencedInput`. Every `bail(...)` message stays byte-identical, because the messages interpolate the value and never the identifier.

`run` keeps one meaning: a workflow execution. The `run:` action's code says command.

- `RunAction` becomes `CommandAction` in both `workflow/grammar.ts` and `engine/`, `localRun` becomes `localCommand`, `placedRun` becomes `placedCommand`. Grammar's `RunAction` is private and reachable only through `StepAction`, and `kind: "run"` and the YAML key `run:` are declared separately, so the type name carries no behavior.
- `runShellStep` and `runArgvStep` are unchanged. They read as "run a step", which is the workflow-execution sense, so they are already correct.

`context.ts` gives up its last two unrelated concerns, following the pattern the credential extraction established.

- New `src/caps.ts` holds the byte caps and their guards: `CAPTURE_BYTE_LIMIT`, `HWF_ENV_BYTE_LIMIT`, `AGENT_PROMPT_BYTE_LIMIT`, `CaptureLimitError`, `assertUnderCaptureCap`, `assertUnderHwfEnvCap`, `assertHwfEnvValues`.
- New `src/transcript.ts` holds transcript extraction: `extractAgentTranscript`, `readClaudeTranscript`, `hasTranscriptSupport`, `transcriptText`.
- `TranscriptExtractor` stays in `context.ts` beside `transcriptSchema`, which is the Zod validator that defines its shape, and beside `WorkflowsConfig`, which declares the field. `transcript.ts` imports the type. `AgentProfile` is structurally identical, plays the identical role, sits beside `profileSchema`, and stays in `context.ts` too.
- `context.ts` keeps product metadata, the generation token, the config layers, and the invocation context.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. Every change is a rename or a verbatim move. No YAML key, CLI flag, config key, history field, or error message changes. `.openspec.yaml` sets `skip_specs: true`.

## Impact

- Code: `src/runs-browser.ts`, `src/picker.ts`, `src/cli.ts`, `src/engine/`, `src/history.ts`, `src/workflow/grammar.ts`, `src/workflow/validate.ts`, `src/context.ts`, plus new `src/caps.ts` and `src/transcript.ts`.
- Layers: `scripts/verify-layers.ts` gains `caps` and `transcript` in the platform layer with their own entries. The dynamic `context.ts -> engine` allowlist edge moves to `transcript.ts -> engine`, because the transcript command is what needs `spawnCapture`. The sideways edge between the two platform modules is `transcript -> context`, and it points one way.
- Tests: import paths and local identifier names update. No assertion changes meaning.
- Sequencing: land `distill-agent-turn` first. It moves much of the same `engine.ts` code, and doing the renames first would guarantee a conflict on every moved line.
- Docs: no user-facing prose changes, because no user-facing name changes.
