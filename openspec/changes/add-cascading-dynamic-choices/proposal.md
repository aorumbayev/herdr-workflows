## Why

Input collection is already adaptive: `when:` guards show or hide questions based on earlier answers, and dynamic choices compute options with a command. But the two mechanisms cannot combine — dynamic choice argv rejects templates and receives no collected values, so a choice command can never depend on an earlier answer. The classic cascading form (pick a repository, then pick one of *that repository's* branches) is impossible, and authors work around it with `allow_custom` free text, which throws away validation. Collection is strictly sequential and the guard-proof machinery already exists, so the relaxation is cheap.

## What Changes

- Dynamic choice argv elements MAY contain templates rooted at `inputs`, referencing earlier declared inputs only. Substitution happens before the command runs. `steps` and `context` roots stay load errors inside dynamic argv.
- Self references and forward references are load errors. Referencing a conditional input requires the consuming input's `when:` to carry every clause that guards the referenced input — the existing guard-proof rule applied to inputs.
- Everything else about dynamic choices is unchanged: repository-root cwd, no partially collected input exports in the environment, 10-second timeout, 1,000-option cap, capture cap, dedup, failure semantics.
- `hwf workflow inspect --resolve` resolves a dependent dynamic choice only when every referenced input is supplied through `--input`, and otherwise prints the unresolved argv without executing it.
- Picker back-navigation behavior is already covered: the existing requirement discards later answers and resolved domains when an earlier value changes, which is exactly the invalidation cascading needs. No picker spec change.
- Detached launch is unchanged: domain snapshots capture the options resolved for the collected answers, and the detached run validates against them without re-running discovery.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-grammar`: dynamic choice argv accepts per-element templates referencing earlier inputs, with forward-reference and guard-proof load rules.
- `hwf-cli`: `workflow inspect --resolve` gains the supplied-values precondition for dependent dynamic choices.

## Impact

- Code: `src/workflow/grammar.ts` (argv template validation, reference rules), `src/workflow/validate.ts` (guard proof for input-to-input references), `src/workflow/inputs.ts` (substitution before resolution, dependent-domain invalidation on back-navigation), `src/cli.ts` (inspect resolution precondition).
- Generated artifacts: `docs/workflow.schema.json` via `bun run schema` if the Zod description text changes.
- Docs: `docs/reference.md`, `docs/guide.md`, `skills/herdr-workflow-create/reference/syntax.md`.
- Tests: `test/workflow`, picker input-session coverage.
- Compatibility: additive only. Existing workflows load and run unchanged, because template-free dynamic argv behaves exactly as before.
