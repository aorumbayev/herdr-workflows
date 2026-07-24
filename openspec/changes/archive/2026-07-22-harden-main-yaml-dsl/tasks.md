## 1. DSL runtime harden

- [x] 1.1 Export `HWF_INPUT_<name>` env on shell steps from resolved inputs
- [x] 1.2 Add `close_source` optional bool on `agent` steps (parse, schema, fire after successful open)
- [x] 1.3 Tests for HWF_INPUT env + close_source success/failure

## 2. Seeded playbooks

- [x] 2.1 Rewrite `handoff` seed to session-first distill + target agent (`close_source`)
- [x] 2.2 Add `worktree` seed using `HWF_INPUT_branch` / `HWF_INPUT_base`
- [x] 2.3 Update init tests for new seed names/contents

## 3. Docs

- [x] 3.1 Guide: session-first handoff, worktree, HWF_INPUT_*, close_source
- [x] 3.2 Examples + reference updates for new modifiers/env
- [x] 3.3 Regenerate `docs/workflow.schema.json` if schema script covers close_source

## 4. Verify

- [x] 4.1 Run `bun test` and fix regressions
