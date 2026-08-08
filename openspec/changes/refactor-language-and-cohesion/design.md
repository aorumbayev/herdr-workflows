# Design

## Context

Findings from a DDD review, each verified against the code with direct file:line evidence:

- **Overloaded nouns.** `token` carries 5 unrelated meanings (`context.ts:41` generation counter, `context.ts:285` credential secret, `host.ts:461` herdr readiness `--token`, `results.ts:98` verdict token, `workbench.ts` auth token). `context` carries 6, `session` ~5-6, `run` ~6, `target` 4. The verified worst offenders for a maintainer are `token` and the engine-local `StepCtx`/`c` alias, which collides with the `context` module and the `{{context.*}}` namespace on the hot path.
- **Field-type splinter.** `validate.ts` imports the field-name sets from `results.ts` but re-hardcodes the field-to-scalar-type map (`exit_code→number`, `failed→boolean`, string fields) around `validate.ts:377-388`, duplicating the `CommandResult`/`AgentResult` types in `results.ts:7-27`. `history.ts:57` hardcodes the zod key `"exit_code"` though `COMMAND_EXIT_CODE_FIELD` is already imported at `history.ts:12`.
- **Outcome triplication.** `StepOutcome` (`engine.ts:85`), `ProgressOutcome` (`history.ts:274`), and `RunStepOutcomeKind` (`history.ts:36`) name the same lifecycle event with near-synonym stems, bridged by conversion code at `recordedOutcomeKind` (`engine.ts:1753`) plus an inline map.
- **Grab-bag files.** `context.ts` (~798 lines) bundles 6 concerns, and the credential/ACL block (`context.ts:109-312`) is fully standalone with its own `CredentialStoreError`. `engine.ts` (~2185 lines) bundles orchestration, pane placement, process capture, the ~420-line agent-turn state machine, and build/detach lifecycle.

The `results.ts` consolidation from a prior change is verified complete and is the pattern to extend.

## Goals / Non-Goals

Goals: remove the two named weaknesses (overloaded nouns, low-cohesion files) with zero behavior change, using the existing test suite as the oracle.

Non-goals: no grammar, CLI, or spec behavior change. No fix to `run`/`session`/`context`/`target` beyond the `token` and `StepCtx` cases named here (the rest are larger renames deferred). No file split done merely to satisfy a line budget.

## Decisions

### D1: Rename by concept, not by mechanical find-replace

`token` renames target only the generation-counter sense (`GenerationToken`, `generation`). The other four senses already have adequate local names and are left alone — the goal is one-word-one-meaning, not uniform prefixes. `tsc` catches every missed caller.

### D2: Field types derive from one home

The scalar-type knowledge moves beside the field-name sets in `results.ts` as a single map keyed by the same constants, and `validate.ts` consumes it. A field's name and its type then change in exactly one place. `history.ts:57` swaps the literal for the imported constant.

### D3: Outcome vocabularies stay distinct, bridged once

The three types are genuinely different layers (runtime outcome, progress line, recorded history), so they are not merged. Instead the single translation function becomes the only bridge, and a `context:` comment records the deliberate distinction so a future reader does not "unify" them by mistake.

### D4: Extractions preserve the layer graph

`src/credentials.ts` joins the platform layer (peer of `context.ts`), and its consumers (`context.ts`, `history.ts`, `workbench.ts`) import it through its entry. The agent-turn module joins the `engine` domain as an internal module imported only by `engine.ts`, or as a `workflows` peer if the layer checker requires an entry — the implementer picks whichever keeps `verify:layers` green with the smaller diff. Both extractions move code verbatim, rewriting no logic.

### D5: Behavior-neutrality is proven by the existing suite

No test assertions change meaning. Tests that reference moved symbols update their import paths only. If any extraction cannot stay behavior-neutral or green, the implementer stops and reports rather than forcing it — the agent-turn distillation especially is a model-clarity move that must not degrade the runner.

## Risks / Trade-offs

- **Agent-turn extraction touches the runner hot path.** Mitigated by moving code verbatim behind an intention-revealing interface, with the full `test/engine` suite as the safety net. This is the highest-risk item. If it fights the layer checker or the tests, it is dropped from this change and re-proposed alone.
- **Rename churn.** Broad but shallow, with `tsc` and `verify:layers` as exact oracles.
- **`verify-layers.ts` map drift.** Adding modules requires editing the module map and entry list, and the checker fails loudly if missed.

## Open Questions

None blocking. Default: if the agent-turn module cannot be a clean internal `engine` file, it becomes a `workflows`-layer module with its own entry, chosen to minimize the layer-map diff.
