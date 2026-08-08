# Design

## Context

The agent-turn region is `src/engine.ts:800-1268`. Read directly, it uses these symbols from outside itself:

- From other modules, already imported by `engine.ts` and unaffected by the cut: `HerdrError` (`host`), `substituteText` (`workflows/grammar`), `AgentProfile` / `resolveProfile` / `configPathsHint` / `globalConfigPath` / `repoConfigPath` / `AGENT_PROMPT_BYTE_LIMIT` / `assertUnderCaptureCap` (`context`), and `parseVerdict` / `verdictMismatchMessage` / `verdictNotRequiredMessage` / `AgentResult` / `ExpectSpec` / `StepFailureDetails` (`workflows/results`).
- From inside `engine.ts`, which is where the cycle claim comes from: `StepFrame` (`engine.ts:131`), `StepOutcome` (`engine.ts:85`), `RunnerDeps` (`engine.ts:96`), `dispatchFailure` (`engine.ts:179`), `generateAgentName` (`engine.ts:205`), `runScratchDir` (`engine.ts:217`), `managedResponsePath` (`engine.ts:221`), `managedPromptSpillPath` (`engine.ts:226`), `appendResponseInstruction` (`engine.ts:230`), `spilledPromptInstruction` (`engine.ts:238`), `readManagedResponse` (`engine.ts:242`), `PlacedPane` (`engine.ts:275`), `placeEmptyPane` (`engine.ts:326`), and `resolvePaneOpen` (`engine.ts:430`).

Sort that second list by what each symbol is and the cycle disappears:

- Step contract: `StepFrame`, `StepOutcome`, `RunnerDeps`, `dispatchFailure`. Shared by every action, not owned by the agent turn.
- Pane placement: `PlacedPane`, `placeEmptyPane`, `resolvePaneOpen`. Shared with the `run` action, which calls `placeCommandPane` at `engine.ts:750` and `resolvePaneOpen` at `engine.ts:746`.
- The agent turn's own scratch and prompt helpers: `generateAgentName`, `managedResponsePath`, `managedPromptSpillPath`, `appendResponseInstruction`, `spilledPromptInstruction`, `readManagedResponse`. Sole consumer is the agent turn. `runScratchDir` has a second caller at `engine.ts:2050`, so it stays a shared helper.

The earlier attempt moved group three and kept groups one and two in `engine.ts`. That is what forced the back-import. Moving all three groups in bottom-up order removes the need for one.

`scripts/verify-layers.ts` never inspects same-module edges: `checkEdges` returns early on `fromMod === toMod` (`verify-layers.ts:157`). Entry restriction, layer direction, and the allowlist all apply only across module boundaries. So the internal cut is invisible to `verify:layers` once `moduleOf` maps the folder, and the only enforcement that matters is TypeScript plus the test suite.

## Goals / Non-Goals

Goals: make the agent-turn mechanism readable and changeable on its own, without a cycle and without altering behavior.

Non-goals: no grammar, CLI, or spec change. No retuning of the turn constants, the settle grace, or the submit-retry policy. No new abstraction over `RunnerDeps`. No split of the detached-launch lifecycle beyond leaving it in the orchestrator.

## Decisions

### D1: Cut bottom-up, not top-down

The cut order is the whole design. `contract` first, then `pane`, then `command`, then `agent-turn`, then `index`. Each file may import only files earlier in that list. Stated as a rule the implementer can check by reading imports, this is cheaper to hold than any tool.

### D2: A folder with one entry, not five sibling modules

`src/engine/` stays one module in the layer map with `src/engine/index.ts` as its only entry. Outsiders keep importing `./engine`, which Node and `resolveImport` (`verify-layers.ts:122`) both resolve to `index.ts`. Making the five files five layer modules would need five entries, five layer numbers, and new sideways edges for no gain.

### D3: Verbatim moves, and the failing test is the answer

Each file is populated by moving declarations unchanged and adding imports. If a test fails, the move was wrong. This is the only oracle, so nothing else may change in the same commit.

### D4: One task per file, in cut order, each independently green

Five tasks, each ending in `bun test ./test`. A stalled task is revertable on its own without unwinding the ones before it, and the branch is never left mid-cut.

### D5: `runScratchDir` stays shared

It has a second caller in the preflight path (`engine.ts:2050`). It belongs in `contract` as a shared helper, not in `agent-turn`. Moving it into `agent-turn` would recreate a back-import from the orchestrator, which is the exact failure this change exists to avoid.

## Risks / Trade-offs

- **The cut touches the runner hot path.** Mitigated by verbatim moves and by `test/engine`, which already covers the settle loop, the submit retry, the Enter nudge, and the verdict gate. Any behavior drift shows up as a failing assertion, not as a silent regression.
- **Five files instead of one raises the cost of a cross-cutting edit.** Accepted. A change that touches the contract and the turn together is rare, and today every change pays the cost of reading all five concerns at once.
- **Import-path churn in tests.** Broad but shallow, and `bunx tsc` names every miss.
- **A later reader may reintroduce a cycle.** The cut order is recorded in D1 and, once the folder exists, in a `context:` comment in `src/engine/contract.ts` stating that nothing in the folder may import the orchestrator.

## Open Questions

None blocking. If a sixth grouping turns out to be needed once the code is in hand, prefer adding a file at the correct position in the cut order over widening an existing one.
