## Why

The product goal is a clean, simple, expressive YAML syntax for automating agent-driven work inside Herdr — what users build with it is up to them. Agent step results undercut that expressiveness today: the response is opaque text, so the only way a later `when:` can react to an agent's answer is a whole-string `==` comparison against the entire managed response, which breaks the moment the agent adds one word of prose. Underneath, the step-result contract is asserted in six unlinked places (`validate.ts` field sets, two `engine.ts` object literals, a Zod description string, `history.ts` failure facts, and the spec), so adding any result field is the riskiest edit in the repository. This change consolidates the result model first, then adds a small verdict contract on top so an agent's outcome becomes an addressable scalar like every other step result.

## What Changes

- New internal step-result contract module: one typed home for command, agent, readiness, herdr, and child result shapes. `validate.ts` field sets and `engine.ts` result binding derive from it. Behavior-neutral.
- One translation function from step outcomes to recorded history outcomes, replacing the two hand-written `launched ? "launched" : "succeeded"` ternaries. Behavior-neutral.
- Typed codec for the detached-run `[i/n]` progress line, following the existing `@hwf-history:` ack codec pattern, so the CLI producer and the runs-browser consumer share one format. Behavior-neutral.
- `expect:` modifier on blocking agent actions: `one_of` declares the exact verdict tokens the agent must end its response with, and optional `require` lists the tokens that let the step succeed. The step result gains a `verdict` string field. A missing or unlisted verdict fails the step with the expected tokens named.
- `hwf response check <file> --one-of <tokens>`: an offline oracle command sharing the runner's verdict parse. The runner's appended instruction tells the agent to run it against the managed response file until it exits zero, turning token emission from instruction-following into a tool-feedback loop the agent's own iteration closes. The runner still applies the same check at settle time, so a skipped self-check fails loudly rather than passing silently.
- Two shipped review examples (diff review gate, propose-critique-revise) plus regenerated gallery data, and an updated `herdr-workflow-create` recipe.

Explicit non-goals, deferred to later changes: MCP exposure, `AGENTS.md`/skill attachment keys on agent steps, a skill or workflow registry, and any parallel fan-out (a `v1alphaN` decision). A full `engine.ts` split is also out: verification showed the launch block is imported only by `picker.ts` and `runs-browser.ts`, so extraction buys less than first claimed and can wait.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-grammar`: the agent action accepts an `expect` modifier, and a blocking managed agent turn with `expect` produces a `verdict` result field with defined parse and failure semantics.
- `hwf-cli`: the public command surface gains `response check`, an offline verdict oracle that never contacts Herdr and never runs preflight.

## Impact

- Code: `src/workflow/grammar.ts` (Zod schema, refinements), `src/workflow/validate.ts` (field sets, verdict reference proof), `src/engine.ts` (verdict instruction, parse, `require` failure, result binding), `src/history.ts` (progress codec, outcome translation), `src/cli.ts` (`response check` subcommand, shared progress codec), `src/runs-browser.ts` (shared progress codec).
- Generated artifacts: `docs/workflow.schema.json` via `bun run schema`, `docs/.vitepress/theme/examples.generated.ts` via `bun run examples`.
- Docs: `docs/reference.md`, `skills/herdr-workflow-create/reference/recipes.md`.
- Tests: `test/workflow`, `test/engine`, `test/history`.
- Compatibility: additive only. Existing workflows load and run unchanged; `verdict` is referencable only when the producer declares `expect`.
