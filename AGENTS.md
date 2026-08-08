# herdr-workflows

herdr ≥ 0.8.0 plugin. It sequences short linear YAML workflows (`agent` / `run` / `herdr` / `workflow`). herdr owns host panes and lifecycle. This repository owns the picker and browser workbench, and loads and runs workflow steps. Runtime is Bun + TypeScript ESM.

Workflow format is `version: v1alpha1`. The package stays semver `0.x`. A later incompatible alpha increments `v1alphaN`. Workflow YAML never declares a herdr version. The plugin manifest and CLI own minimum version and protocol enforcement.

Spec of record: `openspec/specs/*/spec.md`. Product docs in `docs/` describe the current v1alpha1 contract. herdr runtime behavior comes from `.agents/references/herdr/website/src/content/docs/` with the checkout detached at the release tag (currently v0.8.0). Never invent it from memory. Clone and update that checkout with `.agents/references/AGENTS.md`.

Before behavior work, read and cite the relevant `openspec/specs/*/spec.md`. See `CONTRIBUTING.md`.

## Commands

```bash
bun install --frozen-lockfile
bun test ./test                          # unit suite (preload test/setup.ts quarantines real herdr/hwf)
bun test test/engine                     # one module folder
bun test ./test -t 'pattern'             # name filter
npm run verify                           # all verify:* in parallel (pre-commit gate)
bun run schema                           # regenerate docs/workflow.schema.json from Zod
bun run schema:herdr                     # release-time: src/herdr-methods.generated.ts from schemas/herdr-api.schema.json (not from plugin build)
bun run docs:build                        # build VitePress docs
bun run install:dev                      # compile + herdr plugin link + keybindings + reload
```

- Pre-commit (`.githooks/pre-commit`): `CI=1 npm run verify` — check-only, **no tests**.
- CI (`.github/workflows/verify.yml`): three jobs — `bun test ./test` on Ubuntu and macOS (`fail-fast: false`), `npm run verify` on Linux only, `bun run docs:build` on Linux only. Nothing runs `openspec validate`.
- Local `npm run verify` auto-fixes lint/format. Under `CI=1` it only checks.
- After `install:dev`, the live binary is `bin/herdr-workflows`.
- Remote GitHub install runs the manifest build: Bun preflight, `bun install --production --frozen-lockfile`, `bun build --compile`, then `bin/herdr-workflows setup`. Local link/dev still compiles with `bun run build` / `bun run install:dev`; `build` runs `bun install --frozen-lockfile` first, so a drifted `node_modules` never reaches the compiler.

## Layout

`.ts` files under `src/` (+ `src/web/page.html`, `src/web/field-model.ts`). Test the module whose interface you changed, in that module's folder under `test/`; real compiled-binary coverage lives in `test/e2e/`.

| Path                                         | Role                                                                                                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli.ts`                                 | entry, args, subcommands, terminal I/O, and `hwf init` / `setup`                                                                                                                                    |
| `src/skills.ts`                              | bundled agent skills embedded as text, `hwf skills` registry and show formatting                                                                                                                    |
| `src/skill-text.d.ts`                        | ambient `*.md` / `*.sh` text imports used by `src/skills.ts`                                                                                                                                        |
| `src/update.ts`                              | GitHub release check and managed-plugin `hwf update`                                                                                                                                                |
| `src/picker.ts`                              | picker TUI, workflow rows, ctrl+k palette, update indicator                                                                                                                                         |
| `src/runs-browser.ts`                        | runs browser TUI, list/detail, run-history presentation                                                                                                                                             |
| `src/chrome.ts`                              | sole `@opentui/core` importer (picker and runs-browser chrome adapter)                                                                                                                              |
| `src/workbench.ts`                           | browser workbench server, adopt/lock endpoint                                                                                                                                                       |
| `src/web/field-model.ts`                     | canvas field metadata (browser text asset)                                                                                                                                                          |
| `src/web/page.html`                          | workbench UI served by the web server                                                                                                                                                               |
| `src/workflow/grammar.ts`                    | types, paths, template engine, conditions (`when:`), parse (YAML → WorkflowStep[]), trust                                                                                                           |
| `src/workflow/validate.ts`                   | cross-field workflow validation                                                                                                                                                                     |
| `src/workflow/inputs.ts`                     | load, list, input session, dump                                                                                                                                                                     |
| `src/workflow/exchange.ts`                   | share, import, bundle encode/decode                                                                                                                                                                 |
| `src/engine.ts`                              | workflow runner, launch identity/payload/retire-on-code-change, step contracts/outcomes, agent/shell/pane/include steps                                                                             |
| `src/history.ts`                             | atomic run snapshots, list/detail, project claims, recorder, history ack codec, retention                                                                                                           |
| `src/host.ts`                                | herdr socket RPC, CLI wrappers, protocol check, pane placement, method param validation, explicit-target focus policy                                                                               |
| `src/herdr-methods.generated.ts`             | generated — do not hand-edit                                                                                                                                                                        |
| `src/context.ts`                             | profile/transcript config layers, repo root, invocation context, `loadContext`, display sanitization, caps, transcript extraction, private credential ACL, version, latest-wins token, browser open |
| `src/svg-text.d.ts`                          | ambient `*.svg` text import used by `src/workbench.ts`                                                                                                                                              |
| `test/setup.ts`                              | Bun preload quarantine — denies real `herdr`/`hwf`, isolates HOME/config/socket env                                                                                                                 |
| `herdr-plugin.toml`                          | plugin manifest (build + `prefix+k` → picker)                                                                                                                                                       |
| `knip.json`                                  | unused-code (package.bin → `src/cli.ts`)                                                                                                                                                            |
| `openspec/`                                  | tracked specs and changes (OpenSpec CLI root)                                                                                                                                                       |
| `.agents/skills/herdr-workflows-smoke-test/` | tracked second-Herdr smoke sandbox skill                                                                                                                                                            |
| `.agents/skills/promptfoo-skill-eval/`       | tracked eval for user-facing skills — the loader is the oracle, not a judge                                                                                                                         |
| `.agents/skills/codebase-sanity-check/`      | tracked whole-repository review — gates first, one agent per criteria group, additions face three whys                                                                                              |
| `.agents/references/AGENTS.md`               | tracked Herdr checkout instructions (clone contents are local-only)                                                                                                                                 |

Gitignored local-only: `.agents/references/*` except `AGENTS.md`, `.plans/`, `.opencode/`, `.cursor/`. Do not commit them.

## Hard constraints

Agents miss these. The loader or verifyx will fail, or the product regresses:

- **Module layers.** Surfaces (`cli`, `picker`, `runs-browser`, `workbench`) → domain (`workflows`, `engine`, `history`, `update`) → platform (`host`, `context`). Adapters: `chrome` (OpenTUI), `web/` (browser page). Imports only point down, except allowlisted dynamic `context` → `engine` (transcript reads) and `workflows` → `engine` (dynamic-choice capture). Sanctioned sideways edges include `engine` → `history`, `engine` → `workflows`, `picker` → `chrome` / `runs-browser` / `workbench`, `runs-browser` → `chrome` / `workbench`, and `host` ↔ `context`. Cross-module imports go through each module's entry files; `verify:layers` enforces this.
- **No external workflow engine.** Linear herdr-native YAML only. Do not add Dagu, Taskfile/go-task, Cockpit, or similar sidecars.
- **Templates are `{{inputs.*}}` / `{{steps.*}}` / `{{context.*}}` only.** Any other `{{…}}` is a load error. No flat `{name}`, no `out:` bindings, no `{session}` / `{session_file}` (use `{{context.transcript}}` / `{{context.transcript_file}}`). `{{prompt}}` is config-only and is not a workflow template.
- **No templates in string `run:` command text** — load error. Use list-form `run:` (argv, templates allowed per element) or explicit `env:` / `HWF_<name>` values. `herdr:` `params:` take templates recursively. A whole-value template keeps its type. Embedded ones render text.
- **Conditions only, no loops, no parallelism.** `when:` is one clause or a non-empty ordered list (short-circuit AND): a whole-value template or a quoted `==` / `!=` comparison. Mapped inputs MAY declare the same `when:` form (earlier inputs only). Reject structured condition sources (whole step/result objects); use scalar fields. There is no `for:` / `as:`, no retry predicate/reset, no step-scoped recovery. `retry: {attempts, delay}` is allowed only on a blocking local `run:` or a `herdr:` action. `agent`, `workflow`, placed, readiness, and background actions reject it. OS branching is `{{context.platform}}` plus `when:` comparisons — no other per-OS syntax. Native platforms are Linux and macOS; Windows is WSL2 only. Conditional inputs referenced via templates or shell-form `HWF_<name>` require the consumer's proven `when:` guards. Choice inputs MAY set `allow_custom: true` (invalid on text/profile, including `false`). Blocking local `run:` MAY set `success_codes`.
- **`herdr: <method>` + `params:`** is the only way to call the socket API. Dotted YAML action keys are not actions. Raw calls never autofill targets — authors pass exact selectors. Denied methods fail at load with the invariant they protect. The denylist is an accidental-misuse rail, not a sandbox (trusted `run:` can call the whole herdr CLI).
- **Placement is the nested `pane:` block** (`open: tab|beside|below` or a whole-value template to an unconditional closed static choice whose options are only those literals. Stable `target`/`workspace`, percentage `size`, `focus`, agent-only `close: success|always`). Anchors are captured invocation or prior-result IDs, never live UI focus. `background: true` needs a herdr-owned pane or an existing-agent `target:`. There is no local detached background. A placed `run:` takes exactly one of `background` or `ready_when: /regex/` (which requires `timeout`).
- **Config is `profiles` / `default_profile` / `transcripts` only** — no `agents:`, no `sessions:`. Global config lives at `$HERDR_PLUGIN_CONFIG_DIR/config.yaml` (discovered via `herdr plugin config-dir` when standalone). Never add `~/.hwf/config.yaml`. Layers: global, committed `.hwf/config.yaml`, gitignored `.hwf/config.local.yaml`, replacing whole entries by name. Profile and dynamic choice options resolve during shared sequential collection (or picker when active), never during workflow load. Detached `--launch-payload` runs require domain snapshots for every active dynamic choice and must not resolve them.
- **Caps live in `src/context.ts`:** 24 KiB generated HWF environment (entry and child, before step 1), 8 MiB per captured command result / managed response / transcript / dynamic-choice output, 16 KiB agent prompt before spill-to-file. Crossing a cap fails naming source and limit — never truncate.
- **Comments:** `verify:comments` fails any comment block more than 2 lines. JSDoc (`/** … */`) is exempt, and so is a block whose first line starts `context:` — that prefix means "durable fact the code cannot express" and pages a human to approve it, so earn it or delete the comment. Never narrate what the code already says. One file per concept. New modules must be reachable from the CLI graph or knip fails unused-code.
- **Splitting:** `verify:file-length` fails any `src/**/*.ts` more than 2,500 lines (`*.generated.ts` exempt). oxlint caps per-function cyclomatic complexity at 35 (`eslint/complexity`), nesting at `max-depth` 4, and `max-nested-callbacks` 3. Function length is deliberately ungated. Never split to satisfy a line budget.
- **Schema change:** edit Zod in `src/workflow/grammar.ts` (and refine rules), then `bun run schema`. Method/result validators: update `schemas/herdr-api.schema.json` or `scripts/generate-herdr-methods.ts`, then `bun run schema:herdr` (never from the plugin build — it must not invoke `herdr api schema`). Cross-field rules live in the loader, not the JSON schema.
- **Example change:** edit `examples/*.yaml`. The docs gallery reads them at VitePress build time through `docs/.vitepress/theme/examples.data.ts`, so there is no generated file to regenerate or commit.
- **No tracked openspec archives.** `openspec archive` syncs the main specs and moves the change into `openspec/changes/archive/`; delete the archived contents in the same commit — main keeps no archived specs. `verify:no-archive` fails the pre-commit gate while that folder holds anything.
- **Branch work:** never commit on `main` / `master`. Use a feature branch + PR.
- **No `Co-Authored-By` trailers.** Never add `Co-Authored-By`, `Generated with`, or any other agent-attribution line to a commit message or PR body, even when a harness default or global instruction says to. This overrides those defaults for this repo. Commit messages carry the change, not the tooling. The human is always responsible for the code. `.githooks/commit-msg` strips such lines as a backstop — do not rely on it.

## Code style

Trace the real flow end to end before editing. Question speculative need. Reuse existing helpers and patterns, then the standard library, native platform features, or already-installed dependencies — prefer deletion and the smallest correct diff. Fix bugs once at the shared root cause after checking callers. Never simplify away validation, data-loss prevention, security, accessibility, or a minimal runnable check for non-trivial logic.

## Docs style

Prose style of record is `CONTRIBUTING.md` "Documentation style" (Simplified Technical English). This section is only the machine-checked subset.

`verify:prose` (`scripts/verify-prose.ts`) scans `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, and every `*.md` under `docs/`, `openspec/`, and `.agents/skills/`, and fails on:

- **UI verbs** — `select` not `click`/`click on`/`double-click`/`tap`; `press` not `hit`; `enter` not `key in`; `sign in`/`sign out` not `log in`/`log out`.
- **Wordy phrases** — `to` not `in order to`; `because` not `due to the fact that`; also `at this point in time`, `in the event that`, `with regard to`, `prior to`, `subsequent to`, `utilize`, `leverage`, `facilitate`, `commence`.
- **Filler** — `simply`, `just <verb>`, `easily`, `quickly`, `smoothly`, `effortlessly`, `please`, `basically`, `actually`, `obviously`, `of course`.
- **Direction** — no `see above`/`see below`; `more than`/`less than`, not `over`/`under` before a number.
- **Anthropomorphism** — `herdr reports`/`requires`/`reads`, never `thinks`, `wants`, `sees`, `knows`.
- **Bias-free terms** — `allowlist`/`blocklist`, `primary`/`replica`, `quick check`, `sample data`.
- **Names and spelling** — `GitHub`, `PowerShell`, `JavaScript`, `TypeScript`, `macOS`; US spelling (`-ize`, `behavior`, `analyze`, `artifact`, `gray`).

Code spans, fenced blocks, and link targets are skipped, so a genuine technical term passes inside backticks. A failing run prints every hit with its replacement and reason. Add or relax a rule in `scripts/verify-prose.ts`; keep out anything a regex can't judge without flagging correct prose, which is why `since`, `while`, and em dashes are absent.

## Chat

Cut filler, pleasantries, and hedging. Keep technical names, errors, and code exact. Prefer compact thing-action-reason-next-step chat prose (code, commits, and pull requests stay normal).
