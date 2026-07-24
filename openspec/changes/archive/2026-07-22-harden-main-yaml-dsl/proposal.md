## Why

Main’s linear YAML DSL is the herdr-native surface. Seeded playbooks need hardening: session-based handoff, worktree ritual, safer shell input env, clearer docs — without an external workflow engine.

## What Changes

- Harden main workflow YAML semantics/docs (placeholders, session vs pane, safety rules).
- Upgrade seeded `handoff` to prefer `{session}` in `stdin` (with `{pane}` still documented as scrollback option).
- Add seeded `worktree` workflow using `HWF_INPUT_*` env for CLI args.
- Add `close_source` on `agent` steps.
- Port agent ergonomics that fit the main runner (session stdin, close source after open).

## Capabilities

### New Capabilities

- `workflow-dsl`: Linear herdr workflow YAML — verbs, placeholders, inputs, composition, safety bans.
- `seeded-playbooks`: Init-seeded handoff / review / worktree workflows and their contracts.

### Modified Capabilities

- (none — `openspec/specs/` empty on main)

## Impact

- `src/init.ts` seeds, `docs/{guide,examples,reference}.md`, `docs/workflow.schema.json`, tests for seeds/placeholders.
- No external workflow engine dependency.
