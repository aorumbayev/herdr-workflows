# Proposal: cli-skills-command

## Why

The user-facing agent skills under `skills/` ship inside the repository but reach users through an external npx installer. The CLI already ships everywhere the plugin runs, so it can serve the skill text itself with no separate install step.

## What Changes

- The public command surface gains a `skills` group with nested `list` and `show <name>`.
- `skills list` prints each bundled skill's name and the one-line description from its frontmatter.
- `skills show <name>` prints the skill's `SKILL.md` plus its `reference/` and `scripts/` files with file-path headers, and fails nonzero naming the available skills for an unknown name.
- Skill text is embedded into the binary at build time, so a compiled install serves it without the repository checkout. The `skills` commands never contact Herdr and run no protocol preflight.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `hwf-cli`: the public command surface gains the `skills` group and its offline-serving behavior.

## Impact

- `src/skills.ts` (new): text-import registry of the bundled skills, list/show formatting.
- `src/cli.ts`: `skills` command group.
- `src/skill-text.d.ts` (new): ambient declarations for the markdown and shell text imports.
- `scripts/verify-layers.ts`: `src/skills.ts` mapped into the `cli` module.
- `test/cli/skills.test.ts` (new): list, show, and unknown-name coverage.
