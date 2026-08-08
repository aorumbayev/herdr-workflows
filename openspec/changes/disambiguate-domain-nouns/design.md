# Design

## Context

Ubiquitous language is only worth anything when one word means one thing. This codebase is otherwise strong on naming, which is what makes the remaining collisions expensive: a reader has learned to trust the names, so an overloaded one misleads instead of merely slowing them down.

The two hardest cases are the ones where both senses appear in the same file:

- `grammar.ts` declares `PaneSpec.target` at line 64 and `AgentAction.target` at line 88. One is a placement anchor, the other is an agent selector. They are twenty-four lines apart.
- `engine.ts` uses `runId` (workflow execution) and `RunAction` (a shell command) in the same functions.

The credential extraction in `refactor-language-and-cohesion` is the precedent for the cohesion half: a standalone cluster with its own error type, moved verbatim to a new platform module, with the reviewer confirming the result was byte-identical. `caps` and `transcript` have the same shape. `caps` owns `CaptureLimitError` and depends on nothing. `transcript` depends on the config layers for its extractor table and on the dynamic `engine` import for the extractor command.

## Goals / Non-Goals

Goals: one word, one meaning, for `session`, `target`, and `run` in the code. Two fewer concerns in `context.ts`. Zero behavior change.

Non-goals:

- **No YAML key renames.** `target:` inside a `pane:` block stays `target:`, and `run:` stays `run:`. Both are shipped grammar. The ambiguity is real for authors, and the answer for authors is documentation, not a breaking rename in a behavior-neutral change. This rules out nothing on the code side: the private types behind those keys are renamed, and the mapping from key to field is one line in `parsePane`. See D7.
- **No herdr vocabulary renames.** `agent_session`, `agent_status`, `pane_id`, and `target` as a herdr selector keep herdr's words at the boundary.
- **No `context` rename.** `{{context.*}}` is grammar, and `InvocationContext` is a correct name for a value object. The `context` collision was already narrowed when `StepCtx` became `StepFrame`, and what remains is the module's low cohesion, which task 4 addresses directly.
- **No new lint rule.** A regex cannot tell which sense of `target` it is reading. The gate for this change is `tsc` plus the test suite.

## Decisions

### D1: Rename the sense that is wrong, keep the sense that is right

For each noun, one sense keeps the word and the others move. `session` stays with the interactive input episode, `target` with the herdr agent selector, `run` with the workflow execution. Those three are the senses a user would also name that way, so the code and the docs end up agreeing.

### D2: `screen` for a TUI surface's live state

`RunsBrowserScreen` and `PickerScreenOpts` describe what the type is: the mutable state of one visible surface. `screen` is not otherwise used in this codebase, so it introduces no new collision. The bare parameter rename `session` to `screen` is the largest single diff in this change and also the highest-value one, because it appears in roughly thirty function signatures a reader passes through.

### D3: `anchor` for a placement reference

`pane:` placement resolves against a captured invocation or prior-result ID, never live UI focus. `anchor` states that. It also removes the last `target` in `engine.ts` that is not a herdr selector, so after this change `target` in engine code always means the same thing.

### D4: Split `caps` and `transcript`, stop there

`context.ts` drops to the config layers, the invocation context, the generation token, and product metadata. Those four are related: they are all "what this invocation is running against". Splitting further would produce modules smaller than their own import blocks.

### D5: Sequence after `distill-agent-turn`

`distill-agent-turn` moves most of the lines this change renames. Landing the renames first would conflict on nearly every moved line and would make the verbatim-move review in that change impossible. If only one of the two ships, ship `distill-agent-turn`.

### D6: One task per noun, each independently green

Five tasks, each ending in the full suite. Any task can be dropped without unwinding the others, so a reviewer who rejects one rename does not reject the change.

### D7: Rename the private type behind a YAML key, keep the key

`PaneSpec` is hand-written, not a `z.infer`, and `parsePane` already maps the schema onto it field by field. So `PaneSpec.target` becomes `anchor` and the mapping line becomes `anchor: raw.target`. The YAML key, the Zod schema, `docs/workflow.schema.json`, the `pane.target` message strings, and the `pane.target` error keys all stay as they are, because each of them names what the author wrote rather than what the loader produced. The same reasoning applies to grammar's private `RunAction`, which becomes `CommandAction`: it is not exported, `kind: "run"` is a separate declaration, and the YAML key is a third.

The three remaining action types (`AgentAction`, `HerdrAction`, `WorkflowAction`) still mirror their YAML keys, so a reader who learns the mirror keeps it. `CommandAction` is the one deliberate break, and it is the one whose key collides with the workflow-execution sense of `run`.

### D8: `TranscriptExtractor` stays with `transcriptSchema`

`transcriptSchema` is the Zod validator that defines the extractor shape, and `WorkflowsConfig` declares the field. Both live in `context.ts`, so `context.ts` is the definition of record. Moving only the TypeScript type into `transcript.ts` split one concept across two files and needed a `context -> transcript` edge to reconnect it.

`AgentProfile` settles it. It is structurally identical, plays the identical role beside `profileSchema`, has more external consumers, and nobody proposed moving it. So the extractor type stays in `context.ts`, `transcript.ts` imports it, and the platform-layer edge is `transcript -> context` alone. `transcript -> caps` and `transcript -> host` are real dependencies and stay.

## Risks / Trade-offs

- **Rename churn across nine files.** Broad but shallow. `tsc` through `verify:check-types` names every miss exactly, and no rename crosses a serialization boundary, so no history snapshot or config file can drift.
- **`transcript.ts` inherits the dynamic `engine` import.** The allowlist edge moves rather than multiplying, and `verify:layers` fails loudly if the entry is wrong.
- **Reviewer disagreement on a chosen word.** Contained by D6: each noun is one revertable task.
- **The user-facing `target:` ambiguity survives.** Accepted and out of scope. Worth a follow-up docs note that `target:` inside `pane:` is an anchor and `target:` on an agent step is an existing agent.

## Open Questions

None blocking. If `screen` reads wrong to the reviewer once the diff is in hand, `view` is the fallback, applied uniformly across both surfaces.
