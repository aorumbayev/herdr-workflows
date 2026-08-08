# Tasks

## 1. Single-source field types (small diff)

- [ ] 1.1 Move the field-to-scalar-type map into `src/workflow/results.ts` beside the field-name sets, keyed by the same constants and derived from `CommandResult` / `AgentResult`
- [ ] 1.2 Replace the hand-written type map in `src/workflow/validate.ts` (around `validate.ts:377-388`) with the shared map
- [ ] 1.3 Use the imported `COMMAND_EXIT_CODE_FIELD` constant as the zod key at `src/history.ts:57`
- [ ] 1.4 Run `bun test test/workflow test/history` as the oracle

## 2. Disambiguate the token and context false cognates (small diff)

- [ ] 2.1 Rename the latest-wins generation counter in `src/context.ts` to `generation` with type `GenerationToken`, updating `current()` callers
- [ ] 2.2 Rename the engine-local per-step bundle `StepCtx` / `c` to `StepFrame` across `src/engine.ts`
- [ ] 2.3 Confirm no other unrelated concept still shares the bare word `token`, leaving the readiness, auth, and verdict tokens under their existing distinct names
- [ ] 2.4 Run `bun test test/engine` and `bunx tsc` (through `verify:check-types`) as the oracle

## 3. One bridge for the outcome vocabularies (small diff)

- [ ] 3.1 Route every `StepOutcome` to `RunStepOutcomeKind` / `ProgressOutcome` conversion through the single translation function, removing any second inline map
- [ ] 3.2 Add a `context:` comment at the translation stating why the three vocabularies are deliberately distinct
- [ ] 3.3 Run `bun test test/engine test/history`

## 4. Extract the credential and ACL security module (structural)

- [ ] 4.1 Move the credential/ACL cluster (`context.ts:109-312`, including `CredentialStoreError`, the ACL parsers, and the `assert*` guards) verbatim into new `src/credentials.ts` in the platform layer
- [ ] 4.2 Update `src/context.ts`, `src/history.ts`, and `src/workbench.ts` to import from `src/credentials.ts`
- [ ] 4.3 Add `src/credentials.ts` to the module map and entry list in `scripts/verify-layers.ts`, keeping `verify:layers` green
- [ ] 4.4 Move any credential-store tests to match, updating import paths only
- [ ] 4.5 Run `bun test ./test` and `CI=1 npm run verify:layers`

## 5. Distill the agent-turn mechanism (structural, model-clarity only)

- [ ] 5.1 Move the agent-turn settle loop and its submit and wait helpers (`awaitManagedTurn`, `submitPrompt`, `newAgentTurn`, `targetTurn`, `managedResult`, and their timing constants, around `engine.ts:800-1261`) verbatim into a cohesive module behind an intention-revealing interface
- [ ] 5.2 Leave `engine.ts` calling that interface as the orchestrator, moving code without rewriting logic
- [ ] 5.3 Update `scripts/verify-layers.ts` for the new module, choosing internal-`engine` file or a `workflows` entry to minimize the layer-map diff
- [ ] 5.4 If the extraction cannot stay behavior-neutral or green, revert task 5 and note it for a standalone proposal
- [ ] 5.5 Run `bun test test/engine`

## 6. Verification

- [ ] 6.1 `bun test ./test`
- [ ] 6.2 `CI=1 npm run verify`
- [ ] 6.3 `bunx @fission-ai/openspec validate refactor-language-and-cohesion --strict`
- [ ] 6.4 `bun run docs:build`
