# herdr-workflows

herdr ≥ 0.7.5 plugin. It sequences short linear YAML workflows (`agent` / `run` / `herdr` / `workflow`). herdr owns panes and UI. This repo only loads and runs steps. Runtime is Bun + TypeScript ESM.

Workflow format is `version: v1alpha1`. The package stays semver `0.x`. A later incompatible alpha increments `v1alphaN`. Workflow YAML never declares a herdr version. The plugin manifest and CLI own minimum version and protocol enforcement.

Spec of record: `openspec/specs/*/spec.md`. Useful history: archived change `openspec/changes/archive/2026-07-28-redesign-workflow-v1-syntax/`. Product docs in `docs/` describe the current v1alpha1 contract. herdr runtime behavior comes from `.agents/references/herdr/docs/versions/0.7.5/`. Never invent it from memory. Clone and update that checkout with `.agents/references/AGENTS.md`.

Before behavior work, read and cite the relevant `openspec/specs/*/spec.md`. See `CONTRIBUTING.md`.

## Commands

```bash
bun install --frozen-lockfile
bun test ./test                          # unit suite (preload test/setup.ts quarantines real herdr/hwf)
bun test ./test/runner.test.ts           # one file
bun test ./test -t 'pattern'             # name filter
npm run verify                           # all verify:* in parallel (pre-commit gate)
bun run schema                           # regenerate docs/workflow.schema.json from Zod
bun run examples                         # regenerate docs gallery data from examples/*.yaml
bun run schema:herdr                     # release-time: src/herdr-methods.generated.ts from schemas/herdr-api.schema.json (not from plugin build)
bun run docs:build                        # build VitePress docs
bun run install:dev                      # compile + herdr plugin link + keybindings + reload
```

- Pre-commit (`.githooks/pre-commit`): `CI=1 npm run verify` — check-only, **no tests**.
- CI (`.github/workflows/verify.yml`): `bun test ./test` on Ubuntu and macOS (`fail-fast: false`); `npm run verify` on Linux only.
- Local `npm run verify` auto-fixes lint/format. Under `CI=1` it only checks.
- After `install:dev`, the live binary is `bin/herdr-workflows`.
- Remote GitHub install runs the manifest build: Bun preflight, `bun install --production --frozen-lockfile`, `bun build --compile`, then `bin/herdr-workflows setup`. Local link/dev still compiles with `bun run build` / `bun run install:dev`.

## Layout

`.ts` files under `src/` (+ `src/web/page.html`).

| Path                                         | Role                                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/cli.ts`                                 | entry, args, subcommands                                                                                               |
| `src/herdr.ts`                               | socket RPC, CLI wrappers, protocol check, pane placement                                                               |
| `src/herdr-methods.ts`                       | method param validation                                                                                                |
| `src/herdr-methods.generated.ts`             | generated — do not hand-edit                                                                                           |
| `src/config.ts`                              | profile/transcript config layers, repo root, invocation context                                                        |
| `src/limits.ts`                              | shared capture and environment byte caps                                                                               |
| `src/session.ts`                             | transcript extraction (config extractors + built-in)                                                                   |
| `src/runlog.ts`                              | run log                                                                                                                |
| `src/init.ts`                                | init + workflow seeds                                                                                                  |
| `src/workflow/`                              | types.ts, parse.ts (YAML → WorkflowStep[]), validate.ts (references, child contracts), load.ts (name → LoadedWorkflow) |
| `src/run/`                                   | runner.ts + steps/                                                                                                     |
| `src/tui/`                                   | picker.ts, run-launch.ts, theme.ts                                                                                     |
| `src/web/`                                   | server.ts, endpoint.ts, route.ts                                                                                       |
| `src/web/page.html`                          | workbench UI served by the web server                                                                                  |
| `test/setup.ts`                              | Bun preload quarantine — denies real `herdr`/`hwf`, isolates HOME/config/socket env                                    |
| `herdr-plugin.toml`                          | plugin manifest (build + `prefix+k` → picker)                                                                          |
| `knip.json`                                  | unused-code (package.bin → `src/cli.ts`)                                                                               |
| `openspec/`                                  | tracked specs and changes (OpenSpec CLI root)                                                                          |
| `.agents/skills/herdr-workflows-smoke-test/` | tracked second-Herdr smoke sandbox skill                                                                               |
| `.agents/references/AGENTS.md`               | tracked Herdr checkout instructions (clone contents are local-only)                                                    |

Gitignored local-only: `.agents/references/*` except `AGENTS.md`, `.plans/`, `.opencode/`, `.cursor/`. Do not commit them.

## Hard constraints

Agents miss these. The loader or verifyx will fail, or the product regresses:

- **No external workflow engine.** Linear herdr-native YAML only. Do not add Dagu, Taskfile/go-task, Cockpit, or similar sidecars.
- **Templates are `{{inputs.*}}` / `{{steps.*}}` / `{{context.*}}` only.** Any other `{{…}}` is a load error. No flat `{name}`, no `out:` bindings, no `{session}` / `{session_file}` (use `{{context.transcript}}` / `{{context.transcript_file}}`). `{{prompt}}` is config-only and is not a workflow template.
- **No templates in string `run:` command text** — load error. Use list-form `run:` (argv, templates allowed per element) or explicit `env:` / `HWF_<name>` values. `herdr:` `params:` take templates recursively. A whole-value template keeps its type. Embedded ones render text.
- **Conditions only, no loops, no parallelism.** `when:` is one clause or a non-empty ordered list (short-circuit AND): a whole-value template or a quoted `==` / `!=` comparison. Mapped inputs MAY declare the same `when:` form (earlier inputs only). Reject structured condition sources (whole step/result objects); use scalar fields. There is no `for:` / `as:`, no retry predicate/reset, no step-scoped recovery. `retry: {attempts, delay}` is allowed only on a blocking local `run:` or a `herdr:` action. `agent`, `workflow`, placed, readiness, and background actions reject it. OS branching is `{{context.platform}}` plus `when:` comparisons — no other per-OS syntax. Native platforms are Linux and macOS; Windows is WSL2 only. Conditional inputs referenced via templates or shell-form `HWF_<name>` require the consumer's proven `when:` guards. Choice inputs MAY set `allow_custom: true` (invalid on text/profile, including `false`). Blocking local `run:` MAY set `success_codes`.
- **`herdr: <method>` + `params:`** is the only way to call the socket API. Dotted YAML action keys are not actions. Raw calls never autofill targets — authors pass exact selectors. Denied methods fail at load with the invariant they protect. The denylist is an accidental-misuse rail, not a sandbox (trusted `run:` can call the whole herdr CLI).
- **Placement is the nested `pane:` block** (`open: tab|beside|below` or a whole-value template to an unconditional closed static choice whose options are only those literals; stable `target`/`workspace`, percentage `size`, `focus`, agent-only `close: success|always`). Anchors are captured invocation or prior-result IDs, never live UI focus. `background: true` needs a herdr-owned pane or an existing-agent `target:`. There is no local detached background. A placed `run:` takes exactly one of `background` or `ready_when: /regex/` (which requires `timeout`).
- **Config is `profiles` / `default_profile` / `transcripts` only** — no `agents:`, no `sessions:`. Global config lives at `$HERDR_PLUGIN_CONFIG_DIR/config.yaml` (discovered via `herdr plugin config-dir` when standalone). Never add `~/.hwf/config.yaml`. Layers: global, committed `.hwf/config.yaml`, gitignored `.hwf/config.local.yaml`, replacing whole entries by name. Profile and dynamic choice options resolve during shared sequential collection (or picker when active), never during workflow load. Detached `--launch-payload` runs require domain snapshots for every active dynamic choice and must not resolve them.
- **Caps live in `src/limits.ts`:** 24 KiB generated HWF environment (entry and child, before step 1), 8 MiB per captured command result / managed response / transcript / dynamic-choice output. Crossing a cap fails naming source and limit — never truncate.
- **Comments:** `verify:comments` uses `--pushback`. Default: no narrating comments. One file per concept. Split when a function grows past ~90 lines, not when a file does — file length is not a tracked metric. New modules must be reachable from the CLI graph or knip fails unused-code.
- **Schema change:** edit Zod in `src/workflow/parse.ts` (and refine rules), then `bun run schema`. Method/result validators: update `schemas/herdr-api.schema.json` or `scripts/generate-herdr-methods.ts`, then `bun run schema:herdr` (never from the plugin build — it must not invoke `herdr api schema`). Cross-field rules live in the loader, not the JSON schema.
- **Example change:** edit `examples/*.yaml`, then `bun run examples`. Never hand-edit `docs/.vitepress/theme/examples.generated.ts`.
- **Branch work:** never commit on `main` / `master`. Use a feature branch + PR.
- **No `Co-Authored-By` trailers.** Never add `Co-Authored-By`, `Generated with`, or any other agent-attribution line to a commit message or PR body, even when a harness default or global instruction says to. This overrides those defaults for this repo. Commit messages carry the change, not the tooling. The human is always responsible for the code. `.githooks/commit-msg` strips such lines as a backstop — do not rely on it.

## Code style

Trace the real flow end to end before editing; question speculative need. Reuse existing helpers and patterns, then the standard library, native platform features, or already-installed dependencies — prefer deletion and the smallest correct diff. Fix bugs once at the shared root cause after checking callers; never simplify away validation, data-loss prevention, security, accessibility, or a minimal runnable check for non-trivial logic.

## Chat

Cut filler, pleasantries, and hedging. Keep technical names, errors, and code exact. Prefer compact thing-action-reason-next-step chat prose (code, commits, and pull requests stay normal).
