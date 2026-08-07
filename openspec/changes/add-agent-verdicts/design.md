# Design

## Context

This change came out of a DDD review of the codebase followed by an adversarial verification pass. Findings that survived verification, with evidence:

- **Step-result contract has six unlinked homes.** `src/workflow/validate.ts:47-48` (`COMMAND_FIELDS`, `AGENT_STRING_FIELDS`), `src/engine.ts:650-658` (`bindCommandResult`), `src/engine.ts:1009` (agent result object literal), `src/workflow/grammar.ts:1010` (Zod `.describe()` prose), `src/history.ts:1130-1141` (`failureFact`), and `openspec/specs/workflow-grammar/spec.md:47`. `bindResult` at `src/engine.ts:1692-1695` types everything as `unknown`, so the compiler links none of them.
- **Six outcome vocabularies, mapping duplicated.** `StepOutcome` (`src/engine.ts:69-78`), `StepsResult` (`:122-131`), `RunStepOutcomeKind` (`src/history.ts:35-42`), `RunTerminalStatus`, `RunProjectedStatus`, and progress strings. The `launched ? "launched" : "succeeded"` map is hand-written at `src/engine.ts:1817` and again at `:1854-1860`.
- **The `[i/n]` progress line is the one untyped wire format.** Produced inline at `src/cli.ts:923-930`, classified by regex at `src/engine.ts:1543`, consumed as opaque text at `src/runs-browser.ts:698-702`. The ack half already has a typed codec (`src/history.ts:239-253`) to copy.
- **A verdict gate is expressible today but fragile.** `when:` equality compares the whole canonical rendering against a quoted literal (`src/workflow/grammar.ts:476-478`, `step-control-flow/spec.md:14`), so the agent must emit only the token with no surrounding prose. There is no substring match and no template-to-template comparison. Hard-stop works through a gated `run:` with `exit 1`.
- **Agent responses have no structure.** `readManagedResponse` (`src/engine.ts:222-236`) checks only existence, the 8 MiB cap, and non-blank. Action kinds are closed (`src/workflow/grammar.ts:474`).

Findings the verification pass killed, recorded so they do not return:

- The claim that extracting the engine launch block decouples `cli.ts` and `workbench.ts`: refuted. `workbench.ts` does not import `engine.ts`, and `cli.ts` needs `runWorkflow` regardless. Only `picker.ts` and `runs-browser.ts` import the launch helpers. Extraction is deferred.
- The claim that sensitivity analysis is re-derived per surface: refuted. One shared implementation lives in `grammar.ts`. Only the two-string constant set (`grammar.ts:386` vs `validate.ts:64`) and a flag-object literal are duplicated. Folding those in is a footnote task, not a phase.
- The claim that CLAUDE.md misstates cap locations: refuted as scoped. The three named content caps do live in `src/context.ts`.

## Goals / Non-Goals

Goals:

- One typed home for step-result shapes, with the other five sites deriving from or citing it.
- One outcome-translation function and no duplicated ternaries.
- One progress-line codec shared by producer and consumer.
- A verdict contract (`expect:`) that turns an agent's outcome into an addressable scalar, so `when:` compares a single token instead of the whole response. Review gates are one pattern this enables. The syntax stays neutral about what users build.
- Shipped, loadable review examples that demonstrate the pattern end to end.

Non-goals (each needs its own change and, for some, a human strategy call):

- MCP exposure of `hwf workflow list/run/inspect`.
- `AGENTS.md` / skill / file attachment keys on agent actions.
- A skill or workflow registry. `src/skills.ts` stays a compiled-in list.
- Parallel fan-out or joins. `step-control-flow` forbids them, and changing that is a `v1alphaN` decision that trades away the product's main simplicity guarantee.
- Splitting `engine.ts` or renaming overloaded terms (`token`, `session`) wholesale.

## Decisions

### D1: `expect` is a result contract, not a new action or control flow

A fifth action kind (`gate:` or `assert:`) would break the "Four explicit actions" requirement and widen the grammar for something conditions already express. Instead `expect` shapes the agent result, and existing `when:` plus a gated failing `run:` provide branching and hard stops. This keeps `step-control-flow` untouched.

### D2: Verdict parse is "final non-empty line, exact token"

The managed-response instruction already tells the agent where to write. `expect` appends one more sentence naming the tokens and the final-line rule. Parsing the final non-empty line tolerates leading reasoning prose, which is the failure mode that breaks whole-response equality today. Tokens are constrained to `[A-Z][A-Z0-9_]{0,31}` so they cannot collide with prose accidentally. Rejected alternative: JSON-schema structured output — a much larger contract (schema authoring, partial parse, error taxonomy) than gating needs.

### D3: The result-contract module lives at `src/workflow/results.ts`

It exports the typed shapes (`CommandResult`, `AgentResult`, readiness and failure-fact field sets) and the derived field-name constants. Layer check: `engine → workflows` and `history → workflows/grammar` edges already exist, and `validate.ts` is inside the module, so no new sideways edge is needed. The Zod `.describe()` strings in `grammar.ts` reference the same constants so prose and validator cannot drift silently.

### D4: Progress codec sits beside the ack codec in `src/history.ts`

`formatProgressLine` / `parseProgressLine` mirror `formatHistoryAck` / `parseHistoryAck`. `cli.ts` calls the formatter, `engine.ts` and `runs-browser.ts` call the parser. The visible format stays `[i/n] label` so nothing user-facing changes.

### D5: Self-check oracle borrows the agent's own loop

Verdict emission is non-deterministic if it rests on instruction-following alone. Instead of building an engine-side retry loop, the appended instruction tells the agent to run `hwf response check <path> --one-of <tokens>` and fix the file until it exits zero. Coding agents already iterate on failing commands, so the check converts token emission into the tool-feedback cycle they handle near-deterministically. This copies the repository's established oracle pattern: the `herdr-workflow-create` skill validates through the real loader until `ok: true`. Reliability comes from three properties: the CLI check and the runner's settle-time gate call one shared parse function so they cannot drift, the runner's gate remains authoritative for agents that skip the self-check, and the command is offline (no Herdr contact, no preflight) so it costs the agent one instant subprocess. Rejected alternative: a dynamically assembled schema validator — for enum tokens the check is one function with zero dependencies, and a future `expect.schema` tier can extend the same command with a `--schema` flag without redesign. Known limitation: a profile with no shell access falls back to instruction-following alone, which matches today's baseline.

### D6: Verdict failures reuse existing failure plumbing

A `require` mismatch or unparseable verdict is an ordinary step failure: `continue_on_error` tolerates it, `on_failure` sees it, history records it through the existing failure fact with the verdict named in the explanation. No `run-history` requirement changes.

## Risks / Trade-offs

- **Agents may still flub the token.** Mitigated by the self-check oracle in the appended instruction, the lenient final-line parse, and a failure message that names the expected tokens so a rerun is informed. Accepted residual risk: weak models will fail the step, which is the gate doing its job.
- **Refactor phases touch the hottest files** (`engine.ts`, `validate.ts`). Mitigated by being behavior-neutral with the existing unit suites as the oracle, and by landing each phase as its own commit so a bisect stays sharp.
- **`one_of` invites boolean-blindness** (`APPROVE`/`REJECT` everywhere). Accepted: tokens are author-chosen and readable in run history, which beats parsing prose.

## Open Questions

None blocking. Defaults chosen: `expect` stays valid on `target:` agent turns because they produce managed responses too. Verdict tokens are not localized. `require` omission means any `one_of` token succeeds and branching is left to `when:`.
