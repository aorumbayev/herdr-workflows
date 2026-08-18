## 1. Grammar

- [x] 1.1 `src/workflow/grammar.ts`: add optional non-empty `name` to `paneSchema` with a description, and carry it on `PaneSpec` and `parsePane`.
- [x] 1.2 `src/workflow/grammar.ts`: reject `pane.name` when literal `pane.open` is `beside` or `below`, at path `["name"]`.
- [x] 1.3 `src/web/field-model.ts`: give `pane.name` a presentation entry so the workbench form keeps it in the placement group.
- [x] 1.4 `bun run schema` to regenerate `docs/workflow.schema.json`.

## 2. Placement

- [x] 2.1 `src/engine/agent-turn.ts`: prefer the rendered `pane.name` over the `hwf-agent` step-ID label.
- [x] 2.2 `src/engine/command.ts`: prefer the rendered `pane.name` over the `hwf-run` step-ID label.

## 3. Coverage

- [x] 3.1 `test/workflows/grammar.test.ts`: `name` loads on `open: tab`, fails on `open: beside`, and survives parse as a template string.
- [x] 3.2 `test/engine/pane.test.ts`: `open: tab` sends the label to `layout.apply` as `tab_label`.
- [x] 3.3 `test/engine/runner.test.ts`: a background agent step with `pane.name` templates renders the name into `tab.create`.

## 4. Docs

- [x] 4.1 `docs/reference.md`: document `pane.name` in the pane section.

## 5. Checks

- [x] 5.1 `bun test ./test`
- [x] 5.2 `CI=1 npm run verify`
- [x] 5.3 `openspec validate --all --strict`
- [x] 5.4 Live check in the second-Herdr smoke sandbox from `.agents/skills/herdr-workflows-smoke-test/`.
