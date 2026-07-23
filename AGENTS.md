# herdr-workflows

herdr ≥ 0.7.4 plugin. Sequences short linear YAML (`shell` / `open` / `agent` / `herdr`). herdr owns panes/UI; this repo only loads and runs steps. Runtime is Bun + TypeScript ESM.

Product docs: `docs/guide.md`, `docs/examples.md`, `docs/reference.md`. Prefer those over inventing DSL behavior.

## Commands

```bash
bun install --frozen-lockfile
bun test ./test                          # unit suite
bun test ./test/runner.test.ts           # one file
bun test ./test -t 'pattern'             # name filter
npm run verify                           # all verify:* in parallel (pre-commit gate)
bun run schema                           # regenerate docs/workflow.schema.json from Zod
bun run install:dev                      # compile + herdr plugin link + keybindings + reload
```

- Pre-commit (`.githooks/pre-commit`): `CI=1 npm run verify` — check-only, **no tests**.
- CI (`.github/workflows/verify.yml`): `bun test ./test` then `npm run verify`.
- Local `npm run verify` auto-fixes lint/format; under `CI=1` it only checks.
- `test/herdr-empirical.test.ts` runs only when `HERDR_SOCKET_PATH` is set; otherwise skipped.
- After `install:dev`, live binary is `bin/herdr-workflows`; the manifest invokes it directly. `bin/hook.mjs` (prefers binary, else `bun src/cli.ts`) remains for stale cached manifests only.

## Layout

| Path                                        | Role                                          |
| ------------------------------------------- | --------------------------------------------- |
| `src/cli.ts`                                | CLI entry (`hwf` / `herdr-workflows`)         |
| `src/adapter/`                              | herdr socket/RPC + picker popup               |
| `src/workflows/`                            | discover, parse, refine, load, substitute     |
| `src/runner/`                               | dispatch / fire / shell / preflight           |
| `src/seed-workflows.ts` / `src/cmd-init.ts` | init seeds + CLI                              |
| `herdr-plugin.toml`                         | plugin manifest (build + `prefix+k` → picker) |
| `knip.json`                                 | unused-code entry is `bin/hook.mjs`           |

Gitignored local-only: `openspec/`, `references/`, `.plans/`, `.claude/`, `.opencode/`, `.cursor/`. Do not commit them.

## Hard constraints

Agents miss these; loader / verifyx will fail or product regresses:

- **No external workflow engine.** Linear herdr-native YAML only. Do not add Dagu, Taskfile/go-task, Cockpit, or similar sidecars.
- **No placeholders in `shell:` / `open:` command text** — load error. Put values in `stdin` / `prompt` / `params`, or use `HWF_INPUT_<name>` env on shell steps. Never interpolate `{input.*}` into shell source.
- **`{session}` / `{session_file}` only in `stdin`.** Handoff-style distill that uses `{agent}` must run from an agent pane.
- **`close_source`** only on `agent:`; closes invoking tab only after target open succeeds.
- **No branches / loops / parallelism / Windows.** Do not invent automatic retry on pane-creating steps (`agent` / `open`) without a herdr create-or-return-by-key API.
- **Comments:** `verify:comments` uses `--pushback`. Default: no narrating comments. Prefer splitting files over gaming complexity/jscpd (duplicate-code `--max-warnings 0`). New modules must be reachable from the CLI graph or knip fails unused-code.
- **Schema change:** edit Zod in `src/workflows/parse.ts` (and refine rules), then `bun run schema`. Cross-field rules live in the loader, not the JSON schema.
- **Branch work:** never commit on `main` / `master`; use a feature branch + PR.

## Chat

Respond terse like smart caveman; keep technical substance. Drop articles/filler/hedging. Pattern: `[thing] [action] [reason]. [next step].` Code, commits, and PRs stay normal prose. `/caveman lite|full|ultra|wenyan` switches level; `stop caveman` / `normal mode` exits. Drop caveman for security warnings, irreversible actions, or when the user is confused.
