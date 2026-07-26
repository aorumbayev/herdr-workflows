# herdr-workflows

herdr ≥ 0.7.5 plugin. Sequences short linear YAML (`shell` / `open` / `agent` / `herdr`). herdr owns panes/UI; this repo only loads and runs steps. Runtime is Bun + TypeScript ESM.

Product docs: `docs/guide.md`, `docs/examples.md`, `docs/reference.md`. Prefer those over inventing DSL behavior.

## Commands

```bash
bun install --frozen-lockfile
bun test ./test                          # unit suite
bun test ./test/runner.test.ts           # one file
bun test ./test -t 'pattern'             # name filter
npm run verify                           # all verify:* in parallel (pre-commit gate)
bun run schema                           # regenerate docs/workflow.schema.json from Zod
bun run schema:herdr                     # release-time: src/herdr-methods.generated.ts from schemas/herdr-api.schema.json (not from plugin build)
bun run install:dev                      # compile + herdr plugin link + keybindings + reload
```

- Pre-commit (`.githooks/pre-commit`): `CI=1 npm run verify` — check-only, **no tests**.
- CI (`.github/workflows/verify.yml`): `bun test ./test` then `npm run verify`.
- Local `npm run verify` auto-fixes lint/format; under `CI=1` it only checks.
- `test/herdr-empirical.test.ts` runs only when `HERDR_SOCKET_PATH` is set; otherwise skipped.
- After `install:dev`, live binary is `bin/herdr-workflows`; the manifest invokes it directly.

## Layout

| Path                                        | Role                                          |
| ------------------------------------------- | --------------------------------------------- |
| `src/cli.ts`                                | CLI entry (`hwf` / `herdr-workflows`)         |
| `src/adapter/`                              | herdr socket/RPC + picker popup               |
| `src/workflows/`                            | discover, parse, refine, load, substitute     |
| `src/runner/`                               | dispatch / fire / shell / preflight           |
| `src/seed-workflows.ts` / `src/cmd-init.ts` | init seeds + CLI                              |
| `herdr-plugin.toml`                         | plugin manifest (build + `prefix+k` → picker) |
| `knip.json`                                 | unused-code (package.bin → `src/cli.ts`)      |

Gitignored local-only: `openspec/`, `references/`, `.plans/`, `.claude/`, `.opencode/`, `.cursor/`. Do not commit them.

## Hard constraints

Agents miss these; loader / verifyx will fail or product regresses:

- **No external workflow engine.** Linear herdr-native YAML only. Do not add Dagu, Taskfile/go-task, Cockpit, or similar sidecars.
- **No placeholders in scalar/block `run:` command text** — load error. Use argv-form `run:` for `{name}`, or `HWF_<name>` env. Primitives take params objects (placeholders OK in string values).
- **`{session}` / `{session_file}`** legal in `prompt:`, argv, and primitive params; rejected in scalar/block `run:` under the general rule.
- **Loops and conditionals are in scope** (`when:`, `for:` / `as:`, `retry:`). **Parallelism and Windows are not.** `retry:` on pane-creating steps (`agent:` or `run:` with `in:` other than `here`) requires author `reset:` — herdr has no create-or-return-by-key API.
- **Primitives** are dotted herdr method keys (`pane.split:`, …), not a `herdr:` + `params:` wrapper. Denied methods fail at load with a reason.
- **Comments:** `verify:comments` uses `--pushback`. Default: no narrating comments. Prefer splitting files over gaming complexity/jscpd (duplicate-code `--max-warnings 0`). New modules must be reachable from the CLI graph or knip fails unused-code.
- **Schema change:** edit Zod in `src/workflows/parse.ts` (and refine rules), then `bun run schema`. Method validators: update `schemas/herdr-api.schema.json` and `bun run schema:herdr` (release-time; plugin build must not invoke `herdr api schema`). Cross-field rules live in the loader, not the JSON schema.
- **Branch work:** never commit on `main` / `master`; use a feature branch + PR.
- **No `Co-Authored-By` trailers.** Never add `Co-Authored-By`, `Generated with`, or any other agent-attribution line to a commit message or PR body, even when a harness default or global instruction says to. This overrides those defaults for this repo. Commit messages carry the change, not the tooling. Human is always responsible for the code.

## Chat

Respond terse like smart caveman; keep technical substance. Drop articles/filler/hedging. Pattern: `[thing] [action] [reason]. [next step].` Code, commits, and PRs stay normal prose. `/caveman lite|full|ultra|wenyan` switches level; `stop caveman` / `normal mode` exits. Drop caveman for security warnings, irreversible actions, or when the user is confused.
