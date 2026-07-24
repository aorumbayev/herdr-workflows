## Why

Editing workflows today means `$EDITOR` on raw YAML (manage TUI) or the CLI. No visual surface to browse repo + global workflows side by side, validate as you type, or move a workflow between scopes. A local web workbench gives that without a new runtime — running still belongs to the picker / `hwf run` because it needs herdr panes.

## What Changes

- Add `hwf web [--port <n>] [--no-open]` — starts a localhost server, opens a bundled single-page UI.
- Web is a **third frontend over existing core**: `collectWorkflowEntries`, `loadConfig`, the workflow load/validate path, `readRunLog`. No logic the CLI lacks.
- Build/manage/share only — **no run from the browser** (needs herdr panes/socket). Editor shows a copy-able `hwf run <name>` instead.
- Extract one shared validator, `parseWorkflowText(name, yaml, agents)`, called by both the file loader and the web `/validate` route — single validator, no drift.
- Sharing = copy/download YAML, import (paste → validate → save), promote repo↔global (refuse clobber).
- Client = one embedded HTML string + vanilla JS + JSON API. No htmx, no framework, no new npm dep.
- Security: bind `127.0.0.1`, per-launch token header, `Origin`/`Host` localhost allowlist on every request.

## Capabilities

### New Capabilities

- `web-workbench`: `hwf web` localhost UI — browse/edit/validate/share repo + global workflows and config over a token-gated JSON API; no in-browser run.

### Modified Capabilities

- `workflow-dsl`: validator exposed as a text-buffer entry point (`parseWorkflowText`) reused by the file loader; behavior unchanged.

## Impact

- New: `src/web/` (server routes + embedded HTML), `hwf web` command in `src/cli.ts`, `src/cli-args.ts` for `--port`/`--no-open`.
- Touched: workflow load path to route through `parseWorkflowText`; `docs/{guide,reference}.md`.
- Deps: none added. `Bun.serve` + vanilla client. `bun build --compile` bundles the HTML string.
- No change to picker / `hwf run` / manage TUI runtime.
