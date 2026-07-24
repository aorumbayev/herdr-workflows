## 1. Shared validator

- [x] 1.1 Extract `parseWorkflowText(name, yaml, agents)` from the file load path
- [x] 1.2 Reroute file loader to read then delegate to `parseWorkflowText` (behavior-preserving)
- [x] 1.3 Test: buffer vs file validation parity (same result + same positioned error)

## 2. Web server

- [x] 2.1 `src/web/server.ts` — `Bun.serve` on `127.0.0.1`, per-launch token, Origin/Host allowlist
- [x] 2.2 Routes: `/api/state`, `GET/PUT/DELETE /api/workflow`, `/api/validate`, `/api/promote`, `GET/PUT /api/config`, `/api/runs`
- [x] 2.3 Promote copies across scope; 409 on clobber unless force
- [x] 2.4 Tests: token reject, foreign-origin reject, validate-no-write, invalid-save reject, promote clobber

## 3. Command wiring

- [x] 3.1 `--port` / `--no-open` in `src/cli-args.ts` (generic flag parser already covers both)
- [x] 3.2 `hwf web` in `src/cli.ts`: resolve repo, start server, open browser unless `--no-open`, print URL

## 4. Client (embedded HTML string)

- [x] 4.1 Single page: tabs Workflows / Config / Runs, entry list (repo-shadow marked), YAML editor
- [x] 4.2 Add-step skeleton buttons; debounced `/api/validate` with inline positioned error
- [x] 4.3 Copy YAML, download `.yaml`, import (paste → save), promote button, `hwf run <name>` footer
- [x] 4.4 Send `x-hwf-token` on every request

## 5. Docs + verify

- [x] 5.1 Guide + reference: `hwf web`, security model, no-run rationale
- [x] 5.2 `bun test` green; `bun build --compile` includes the HTML string
