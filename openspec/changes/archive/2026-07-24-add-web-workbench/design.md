## Context

CLI, manage TUI, and picker already wrap a small pure core (discover, parse/validate, config, runlog). `hwf web` adds a browser frontend over that same core for the tasks a browser does better than `$EDITOR`: side-by-side browse, live validation, scope moves, copy/import. Running is deliberately excluded — it requires the herdr socket and a real invoking pane (`{pane}`, `{selection}`, `{tab}`, agent panes), which a browser has none of.

## Goals / Non-Goals

**Goals:**

- `hwf web` serves a single-page workbench on localhost over a JSON API.
- Reuse the exact CLI validator so web errors == CLI errors.
- Manage repo + global workflows and config; share via copy/download/import/promote.
- Zero new dependencies; bundles into the compiled binary.

**Non-Goals:**

- Running workflows from the browser (stays on picker / `hwf run`).
- Networked sharing (gist/URL/registry), auth beyond a localhost token.
- DAG canvas / per-step structured forms — the model is a flat step list.
- htmx / any client framework.

## Decisions

1. **Third frontend, not a new runtime.** Server routes call existing functions only. `resolveRepoRoot(cwd)` picks the repo, same as every command.
2. **Single validator.** Extract `parseWorkflowText(name, yaml, agents)` from the current file loader; the loader reads the file then calls it, and `/validate` calls it on the unsaved buffer. One code path rejects violations (no second validator to drift).
3. **JSON boundary, vanilla client.** Server returns JSON; client renders with `fetch` + `innerHTML`. Chosen over htmx because the app is one page with one stateful widget (the YAML editor) whose interactivity — cursor insertion of step skeletons, clipboard, blob download, debounced validate — is client JS regardless; htmx would only cover the cheap round-trips while forcing HTML-fragment responses and a second mental model. JSON is also directly testable.
4. **No run button.** Editor footer surfaces `hwf run <name>`; honest about the pane constraint.
5. **Builder = raw YAML + add-step skeletons.** Textarea plus buttons that insert verb templates (`- shell:` / `- agent:` / `- open:` / `- herdr:` / `- run:`). Debounced POST `/api/validate` shows the positioned parser error inline.
6. **Sharing.** Copy/download = client-side from loaded text. Import = paste → PUT (validated). Promote = server copies the file across scope, refusing to overwrite an existing target name.
7. **Bundling.** HTML as an embedded string; `Bun.serve` static-serves it. `bun build --compile` already inlines string imports — no build pipeline, no CDN, no CSP exception.

## API (all routes token-gated + Origin/Host allowlisted)

```
GET    /                       embedded HTML
GET    /api/state              {repoRoot, entries:[{name,source,valid}], agents}
GET    /api/workflow?name&scope   {text, valid, error}
POST   /api/validate  {text}      {ok, error?}          # no write
PUT    /api/workflow  {name,scope,text}   validate→write; {ok,error?}
DELETE /api/workflow  {name,scope}
POST   /api/promote   {name,from,to[,force]}   copy repo↔global; 409 on clobber unless force
GET    /api/config?scope / PUT             config.yaml (loadConfig-validated)
GET    /api/runs                           readRunLog (read-only)
```

## Security

Local HTTP that reads/writes `.hwf` files is reachable by any page the user visits (CSRF / DNS-rebind). Mitigations, all required:

- Bind `127.0.0.1` only (never `0.0.0.0`).
- Random token minted per `hwf web` launch, embedded in the opened URL, echoed by the page as an `x-hwf-token` header; every route (read and write) checks it.
- Reject requests whose `Origin`/`Host` is not the bound localhost address.

## Risks / Trade-offs

- **Stale editor buffer vs on-disk change** (TUI/CLI edits same file) → `/api/state` reload is manual; last-write-wins. Acceptable for a single-user local tool; document it.
- **Promote clobber** → refuse when target name exists; require explicit `force` (confirm in UI). Never silently shadow.
- **Validator extraction regression** → covered by reusing one path + a `parseWorkflowText` unit test asserting parity with a file-load error.
- **Token leak via browser history** → token is per-launch and dies with the process; low value.

## Migration Plan

1. Land on a feature branch; additive only.
2. Extract `parseWorkflowText`, reroute file loader through it (behavior-preserving), keep tests green.
3. Add `src/web/` + `hwf web` command + docs.
4. Rollback: revert PR; no data migration, no config change.

## Resolved

- **Config tab in v1** — mirrors manage TUI (read/write `config.yaml`, `loadConfig`-validated).
- **Port** — default `7317`; if busy, increment (`7318`, `7319`, …) until a free port binds, then print the chosen URL.

## Open Questions

- None blocking.
