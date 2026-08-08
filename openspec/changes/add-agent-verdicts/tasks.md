# Tasks

## 1. Step-result contract consolidation (behavior-neutral)

- [x] 1.1 Create `src/workflow/results.ts` with typed shapes for command, agent, readiness, and failure-fact results plus derived field-name constants
- [x] 1.2 Replace `COMMAND_FIELDS` / `AGENT_STRING_FIELDS` / `READINESS_ID_FIELDS` literals in `src/workflow/validate.ts` with imports from the contract module
- [x] 1.3 Type `bindCommandResult` and the agent result literal in `src/engine.ts` against the contract module, and remove the `unknown` laundering in `bindResult` where practical
- [x] 1.4 Point the Zod `.describe()` result prose in `src/workflow/grammar.ts` at the shared constants, then run `bun run schema` and confirm `docs/workflow.schema.json` is unchanged
- [x] 1.5 Fold the duplicated sensitive-key constant (`grammar.ts:386` vs `validate.ts:64`) into one export
- [x] 1.6 Run `bun test test/workflow test/engine` as the behavior oracle

## 2. Outcome translation (behavior-neutral)

- [x] 2.1 Add one translation function from `StepOutcome` to `RunStepOutcomeKind`, replacing both hand-written ternaries at `src/engine.ts:1817` and `:1854-1860`
- [x] 2.2 Add a unit test that enumerates every `StepOutcome` shape and asserts the recorded kind

## 3. Progress-line codec (behavior-neutral)

- [x] 3.1 Add `formatProgressLine` / `parseProgressLine` beside the ack codec in `src/history.ts`, keeping the visible `[i/n] label` format
- [x] 3.2 Use the formatter in `src/cli.ts` and the parser in `src/engine.ts` and `src/runs-browser.ts`
- [x] 3.3 Add a round-trip test in `test/history`

## 4. Verdict contract (`expect:`)

- [x] 4.1 Add the `expect` Zod schema to the agent action in `src/workflow/grammar.ts`: `one_of` (distinct tokens `[A-Z][A-Z0-9_]{0,31}`), optional `require` (non-empty subset), load error with `background: true`
- [x] 4.2 Add the verdict reference proof to `src/workflow/validate.ts`: `steps.<id>.verdict` resolves only when the producer declares `expect`
- [x] 4.3 Add the shared verdict parse function (final non-empty line, exact token match) to `src/workflow/results.ts`
- [x] 4.4 In `src/engine.ts`, append the verdict and self-check instruction to the managed-response instruction, apply the shared parse at settle time, bind `verdict` into the agent result, and fail on unparseable or non-`require` verdicts naming the tokens
- [x] 4.5 Record verdict failures through the existing failure fact with the verdict in the explanation
- [x] 4.6 Run `bun run schema` to regenerate `docs/workflow.schema.json`
- [x] 4.7 Add grammar, validate, and engine tests: load errors, verdict parse, `require` failure, `when:` gating on `{{steps.x.verdict}}`, tolerated failure, recovery

## 5. Response check oracle (`hwf response check`)

- [x] 5.1 Add the `response check <file> --one-of <tokens>` subcommand to `src/cli.ts`, calling the shared parse function, with no Herdr contact and no preflight
- [x] 5.2 Exit zero printing the verdict on a match, exit nonzero naming the offending final line and expected tokens on a mismatch, and exit nonzero naming the path for a missing or empty file
- [x] 5.3 Validate `--one-of` tokens with the same rules as `expect.one_of`
- [x] 5.4 Add CLI tests covering match, decorated-verdict mismatch, missing file, and bad token list

## 6. Examples, skill, and docs

- [x] 6.1 Add `examples/review-gate.yaml`: diff capture, reviewer with `expect: {one_of: [APPROVE, REJECT]}`, and a gated failing `run:` that repeats the producer's guards
- [x] 6.2 Add `examples/adversarial-revise.yaml`: propose, critique with `expect: {one_of: [APPROVE, REVISE]}`, one revision step gated on `REVISE`
- [x] 6.3 Run `bun run examples` to regenerate the gallery data
- [x] 6.4 Update `skills/herdr-workflow-create/reference/recipes.md` review-gate recipe and `reference/syntax.md` for `expect` and the self-check oracle
- [x] 6.5 Document `expect` and `hwf response check` in `docs/reference.md` and run `bun run docs:build`

## 7. Verification

- [x] 7.1 `bun test ./test`
- [x] 7.2 `npm run verify`
- [x] 7.3 `bunx @fission-ai/openspec validate add-agent-verdicts --strict`
