## Why

A DDD review (verified against the code) graded the codebase Strong on the parts hardest to retrofit — intention-revealing names, side-effect-free functions, value objects, and the herdr anticorruption layer — and Weak on exactly two retrofittable things: overloaded nouns (one word carrying many meanings) and two grab-bag files that bundle unrelated concerns. Both hurt a lone maintainer's ability to hold the model in their head. This change fixes them without altering any behavior.

## What Changes

Naming and single-sourcing (small diffs):

- Disambiguate the `token` false cognate. The latest-wins generation counter in `context.ts` becomes `generation` (type `GenerationToken`). The herdr readiness report token, the workbench auth token, and the verdict token keep distinct names so no two unrelated concepts share the word.
- Single-source the step-result field types. The hand-written field-to-scalar-type map in `validate.ts` derives from the `CommandResult` / `AgentResult` types in `results.ts` instead of duplicating them, and `history.ts` uses the exported `COMMAND_EXIT_CODE_FIELD` constant rather than the literal key.
- Give the outcome vocabularies one documented bridge. `StepOutcome`, `ProgressOutcome`, and `RunStepOutcomeKind` stay distinct by layer, but a single named translation is the only conversion, with a `context:` comment stating why the three differ.
- Rename the engine-local per-step bundle `StepCtx` / `c` to `StepFrame` to remove the worst `context` false cognate on the hot path.

Cohesion (structural, behavior-neutral extractions):

- Extract the credential and ACL security cluster out of `context.ts` into a new platform module `src/credentials.ts`. The cluster is standalone: it owns its error type and has no config or template dependency.
- Distill the agent-turn mechanism (the managed-turn settle loop and its submit and wait helpers) out of `engine.ts` into a cohesive module behind an intention-revealing interface, leaving `engine.ts` as the orchestrator. This is a model-clarity move, not a line-budget split.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. Every change is behavior-neutral: renames, one-constant substitutions, and module extractions with no change to observable workflow behavior, so `.openspec.yaml` sets `skip_specs: true`.

## Impact

- Code: `src/context.ts`, `src/workflow/results.ts`, `src/workflow/validate.ts`, `src/history.ts`, `src/engine.ts`, plus new `src/credentials.ts` and the extracted agent-turn module. `scripts/verify-layers.ts` module map and entry list gain the new modules.
- Tests: `test/engine`, `test/workflow`, `test/history`, `test/context`, and any credential-store coverage move with their symbols. Behavior assertions are unchanged.
- Compatibility: no public surface, no YAML grammar, no CLI, and no spec behavior changes. The full suite and `verify` are the behavior oracle.
