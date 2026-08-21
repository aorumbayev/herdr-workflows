# herdr-workflows

herdr ≥ 0.8.2 plugin. It sequences short linear YAML workflows (`agent` / `run` / `herdr` / `workflow`). herdr owns host panes and lifecycle. This repository owns the picker and browser workbench, and loads and runs workflow steps. Runtime is Go with Charm TUI adapters.

Workflow format is `version: v1alpha1`. The package stays semver `0.x`. A later incompatible alpha increments `v1alphaN`. Workflow YAML never declares a herdr version. The plugin manifest and CLI own minimum version and protocol enforcement.

Spec of record: `openspec/specs/*/spec.md`. Product docs in `docs/` describe the current v1alpha1 contract. herdr runtime behavior comes from `.agents/references/herdr/website/src/content/docs/` with the checkout detached at the release tag (currently v0.8.2). Never invent it from memory. Clone and update that checkout with `.agents/references/AGENTS.md`.

Before behavior work, read and cite the relevant `openspec/specs/*/spec.md`. See `CONTRIBUTING.md`.

## Commands

```bash
go tool verify                             # every host-feasible check (same as CI)
go tool verify -fast                       # pre-commit
go run ./scripts/generate-workflow-schema  # regenerate docs/workflow.schema.json
go run ./scripts/gen-herdr-methods         # regenerate internal/host/herdr_methods.gen.go
go run ./scripts/install-dev               # compile + herdr plugin link + keybindings + reload
```

- Pre-commit (`.githooks/pre-commit`): `go tool verify -fast`.
- CI (`.github/workflows/verify.yml`): `go tool verify` on Linux and macOS after it installs Node.js, golangci-lint, and the OpenSpec CLI. Docs publish (`.github/workflows/docs.yml`) runs `npm ci && npm run build` in `docs/`.
- After `go run ./scripts/install-dev`, the live binary is `bin/herdr-workflows`.
- Remote GitHub install runs the manifest build: Go preflight, `go build -o bin/herdr-workflows .`, then `bin/herdr-workflows setup`. Local link/dev compiles with `go build` / `go run ./scripts/install-dev`.

## Layout

Go packages under `internal/` and `embed/` (workbench HTML and field-model bytes). Test the Go package whose interface you changed.

| Path                                         | Role                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `main.go`                                    | plugin binary entry                                                                                           |
| `internal/cli/`                              | Cobra commands, terminal I/O, `hwf init` / `setup`                                                            |
| `internal/skills/`                           | bundled agent skills embedded as text, `hwf skills` registry and show formatting                              |
| `internal/update/`                           | GitHub release check and managed-plugin `hwf update`                                                          |
| `internal/picker/`                           | picker TUI, workflow rows, ctrl+k palette, update indicator                                                   |
| `internal/runsbrowser/`                      | runs browser TUI, list/detail, run-history presentation                                                       |
| `internal/tui/`                              | Charm lipgloss/bubbletea adapter shared by picker and runs browser                                            |
| `internal/workbench/`                        | browser workbench server, adopt/lock endpoint, embedded page                                                  |
| `internal/workflow/`                         | Workflow Authoring: Definition, document parse, templates, conditions (`when:`), trust, exchange, inputs      |
| `internal/engine/`                           | Workflow Execution: Run, workflow runner, step runners, pane placement, agent turns, detached launch          |
| `internal/history/`                          | Run Observation: Snapshot, Summary, Detail, project claims, recorder, retention                               |
| `internal/host/`                             | Herdr Adapter: explicit identities, generated params/result validation, denylist rail, socket RPC, CLI        |
| `internal/config/`                           | profile/transcript config layers, repo root, invocation context                                               |
| `internal/caps/`                             | byte caps and their guards                                                                                    |
| `internal/transcript/`                       | transcript extractor table, built-in Claude transcript read                                                   |
| `internal/credentials/`                      | private credential store and file ACL checks                                                                  |
| `scripts/build-examples/`                    | VitePress example gallery JSON helper (`go run ./scripts/build-examples`)                                     |
| `docs/package.json`                          | scoped VitePress 1.6.4 package (`npm ci` / `npm run build` in `docs/`)                                        |
| `herdr-plugin.toml`                          | plugin manifest (build + `prefix+k` → picker)                                                                 |
| `openspec/`                                  | tracked specs and changes (OpenSpec CLI root)                                                                 |
| `skills/`                                    | tracked user-facing agent skills (`herdr-workflow-create`, `herdr-workflow-upgrade`) embedded into the binary |
| `.agents/skills/herdr-workflows-smoke-test/` | tracked second-Herdr smoke sandbox skill                                                                      |
| `.agents/skills/promptfoo-skill-eval/`       | tracked eval for user-facing skills — the loader is the oracle, not a judge                                   |
| `.agents/skills/codebase-sanity-check/`      | tracked whole-repository review — gates first, one agent per criteria group, additions face three whys        |
| `.semrelrc`                                  | go-semantic-release plugin config (`.github/workflows/release.yml` dispatches tagged releases)                  |
| `scripts/write-release-notes/`               | appends Go 1.27 install footer to dry-run changelog for `gh release create`                                   |
| `.agents/references/AGENTS.md`               | tracked Herdr checkout instructions (clone contents are local-only)                                           |

Gitignored local-only: `.agents/references/*` except `AGENTS.md`, `.plans/`, `.opencode/`, `.cursor/`. Do not commit them.

## Hard constraints

Agents miss these. The loader or verifyx will fail, or the product regresses:

- **Module layers.** Surfaces (`internal/cli`, `internal/picker`, `internal/runsbrowser`, `internal/workbench`) → domain (`internal/workflow`, `internal/engine`, `internal/history`, `internal/update`) → platform (`internal/host`, `internal/config`, `internal/caps`, `internal/transcript`, `internal/credentials`). Adapters: `internal/tui` (Charm), workbench embedded HTML. Imports only point down through each package's exported API.
- **No external workflow engine.** Linear herdr-native YAML only. Do not add Dagu, Taskfile/go-task, Cockpit, or similar sidecars. Agent-steering rule — no gate enforces it.
- **Templates are `{{inputs.*}}` / `{{steps.*}}` / `{{context.*}}` only.** Any other `{{…}}` is a load error. No flat `{name}`, no `out:` bindings, no `{session}` / `{session_file}` (use `{{context.transcript}}` / `{{context.transcript_file}}`). `{{prompt}}` is config-only and is not a workflow template.
- **No templates in string `run:` command text** — load error. Use list-form `run:` (argv, templates allowed per element) or explicit `env:` / `HWF_<name>` values. `herdr:` `params:` take templates recursively. A whole-value template keeps its type. Embedded ones render text.
- **Conditions only, no loops, no parallelism.** `when:` is one clause or a non-empty ordered list (short-circuit AND): a whole-value template or a quoted `==` / `!=` comparison. Mapped inputs MAY declare the same `when:` form (earlier inputs only). Reject structured condition sources (whole step/result objects) — use scalar fields. There is no `for:` / `as:`, no retry predicate/reset, no step-scoped recovery. `retry: {attempts, delay}` is allowed only on a blocking local `run:` or a `herdr:` action. `agent`, `workflow`, placed, readiness, and background actions reject it. OS branching is `{{context.platform}}` plus `when:` comparisons — no other per-OS syntax. Native platforms are Linux and macOS. Windows is WSL2 only. Conditional inputs referenced via templates or shell-form `HWF_<name>` require the consumer's proven `when:` guards. Choice inputs MAY set `allow_custom: true` (invalid on text/profile, including `false`). Blocking local `run:` MAY set `success_codes`.
- **`herdr: <method>` + `params:`** is the only way to call the socket API. Dotted YAML action keys are not actions. Raw calls never autofill targets — authors pass exact selectors. Denied methods fail at load with the invariant they protect. The denylist is an accidental-misuse rail, not a sandbox (trusted `run:` can call the whole herdr CLI).
- **Placement is the nested `pane:` block** (`open: tab|beside|below` or a whole-value template to an unconditional closed static choice whose options are only those literals. Stable `target`/`workspace`, percentage `size`, `focus`, agent-only `close: success|always`). Anchors are captured invocation or prior-result IDs, never live UI focus. `background: true` needs a herdr-owned pane or an existing-agent `target:`. There is no local detached background. A placed `run:` takes exactly one of `background` or `ready_when: /regex/` (which requires `timeout`).
- **Config is `profiles` / `default_profile` / `transcripts` only** — no `agents:`, no `sessions:`. Global config lives at `$HERDR_PLUGIN_CONFIG_DIR/config.yaml` (discovered via `herdr plugin config-dir` when standalone). Never add `~/.hwf/config.yaml`. Layers: global, committed `.hwf/config.yaml`, gitignored `.hwf/config.local.yaml`, replacing whole entries by name. Profile and dynamic choice options resolve during shared sequential collection (or picker when active), never during workflow load. Detached `--launch-payload` runs require domain snapshots for every active dynamic choice and must not resolve them.
- **Caps live in `internal/caps/`:** 24 KiB generated HWF environment (entry and child, before step 1), 8 MiB per captured command result / managed response / transcript / dynamic-choice output, 256 MiB raw `claude` session file loaded by built-in extraction (the 8 MiB transcript cap applies to the extracted text, and one JSONL record in that file caps at 32 MiB), 16 KiB agent prompt before spill-to-file. Crossing a cap fails naming source and limit — never truncate.
- **Comments:** `go run ./scripts/verify-comments` fails any comment block in `internal/` more than 2 lines. A block whose first line starts `context:` means "durable fact the code cannot express" and pages a human to approve it, so earn it or delete the comment. Never narrate what the code already says. One file per concept.
- **Splitting:** keep Go packages focused. `go run ./scripts/verify-file-length` gates Go source length.
- **Schema change:** edit workflow schema sources in `internal/workflow/`, then `go run ./scripts/generate-workflow-schema`. Method/result validators: update `schemas/herdr-api.schema.json` or `scripts/gen-herdr-methods`, then `go run ./scripts/gen-herdr-methods` (never from the plugin build — it must not invoke `herdr api schema`). Cross-field rules live in the loader, not the JSON schema.
- **Example change:** edit `examples/*.yaml`. The docs gallery reads them at VitePress build time through `docs/.vitepress/theme/examples.data.ts`, so there is no generated file to regenerate or commit.
- **No tracked openspec archives.** `openspec archive` syncs the main specs and moves the change into `openspec/changes/archive/`. Delete the archived contents in the same commit — main keeps no archived specs. `verify:no-archive` fails the pre-commit gate while that folder holds anything.
- **Color literals are unguarded.** No verify gate scans `embed/page.html` or `docs/.vitepress/theme` for hardcoded colors. Review them by hand.
- **Branch work:** never commit on `main` / `master`. Use a feature branch + PR.
- **No `Co-Authored-By` trailers.** Never add `Co-Authored-By`, `Generated with`, or any other agent-attribution line to a commit message or PR body, even when a harness default or global instruction says to. This overrides those defaults for this repo. Commit messages carry the change, not the tooling. The human is always responsible for the code. `.githooks/commit-msg` strips such lines as a backstop — do not rely on it.

## Code style

Agent-steering rules. No machine checks this section.

Trace the real flow end to end before editing. Question speculative need. Reuse existing helpers and patterns, then the standard library, native platform features, or already-installed dependencies — prefer deletion and the smallest correct diff. Fix bugs once at the shared root cause after checking callers. Never simplify away validation, data-loss prevention, security, accessibility, or a minimal runnable check for non-trivial logic.

## Docs style

Prose style of record is `CONTRIBUTING.md` "Documentation style" (Simplified Technical English). This section is only the machine-checked subset.

`go run ./scripts/verify-prose` scans `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, and every `*.md` under `docs/`, `openspec/`, `skills/`, and `.agents/skills/`, and fails on:

- **UI verbs** — `select` not `click`/`click on`/`double-click`/`tap`. `press` not `hit`. `enter` not `key in`. `sign in`/`sign out` not `log in`/`log out`.
- **Wordy phrases** — `to` not `in order to`. `because` not `due to the fact that`. Also `at this point in time`, `in the event that`, `with regard to`, `prior to`, `subsequent to`, `utilize`, `leverage`, `facilitate`, `commence`.
- **Filler** — `simply`, `just <verb>`, `easily`, `quickly`, `smoothly`, `effortlessly`, `please`, `basically`, `actually`, `obviously`, `of course`.
- **Direction** — no `see above`/`see below`. `more than`/`less than`, not `over`/`under` before a number.
- **Anthropomorphism** — `herdr reports`/`requires`/`reads`, never `thinks`, `wants`, `sees`, `knows`.
- **Bias-free terms** — `allowlist`/`blocklist`, `primary`/`replica`, `quick check`, `sample data`.
- **Names and spelling** — `GitHub`, `PowerShell`, `JavaScript`, `TypeScript`, `macOS`. US spelling (`-ize`, `behavior`, `analyze`, `artifact`, `gray`).
- **Punctuation** — no semicolons in prose, including after a code span.

Code spans, fenced blocks, and link targets are skipped, so a genuine technical term passes inside backticks. A failing run prints every hit with its replacement and reason. Add or relax a rule in `scripts/verify-prose.ts`, and keep out anything a regex can't judge without flagging correct prose, which is why `since`, `while`, and em dashes are absent.

## Chat

Cut filler, pleasantries, and hedging. Keep technical names, errors, and code exact. Prefer compact thing-action-reason-next-step chat prose (code, commits, and pull requests stay normal).
