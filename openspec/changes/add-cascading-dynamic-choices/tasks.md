# Tasks

## 1. Grammar and validation

- [ ] 1.1 Allow `inputs`-rooted templates in dynamic choice argv elements in `src/workflow/grammar.ts`, keeping `steps` and `context` roots as load errors with the rule named
- [ ] 1.2 Reject self and forward references at load, naming the offending input
- [ ] 1.3 Apply the guard-proof rule in `src/workflow/validate.ts`: a reference to a conditional input requires the consuming input's `when:` to carry every producer clause
- [ ] 1.4 Run `bun run schema` and confirm whether `docs/workflow.schema.json` changed, regenerating docs text if so
- [ ] 1.5 Add grammar and validate tests: cascading load, forward reference, self reference, missing guard, `steps`/`context` root rejection

## 2. Collection runtime

- [ ] 2.1 Substitute referenced answers into dynamic argv elements before execution in `src/workflow/inputs.ts`, with no partial-input environment exports
- [ ] 2.2 Discard dependent resolved domains and answers when back-navigation changes an earlier value, matching the existing picker requirement
- [ ] 2.3 Confirm launch-payload domain snapshots carry dependent domains unchanged and detached validation stays re-execution-free
- [ ] 2.4 Add input-session tests: cascade resolution order, back-navigation invalidation, dependent domain in a launch payload

## 3. Inspect

- [ ] 3.1 In `src/cli.ts`, resolve a dependent choice under `--resolve` only when every referenced input is supplied through `--input`, and otherwise print the unresolved argv without executing it
- [ ] 3.2 Add CLI tests: dependent choice with and without supplied values

## 4. Docs and examples

- [ ] 4.1 Document cascading dynamic choices in `docs/reference.md` and `docs/guide.md`
- [ ] 4.2 Update `skills/herdr-workflow-create/reference/syntax.md` with the reference rules
- [ ] 4.3 Consider a cascading example (repository then branch) in `examples/`, then run `bun run examples` if added

## 5. Verification

- [ ] 5.1 `bun test ./test`
- [ ] 5.2 `npm run verify`
- [ ] 5.3 `bunx @fission-ai/openspec validate add-cascading-dynamic-choices --strict`
