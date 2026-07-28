# Reference

Contract for `version: v1alpha1`. Cross-field rules are enforced by the loader; `docs/workflow.schema.json` covers shape only.

## Document

| Key           | Required | Notes                                          |
| ------------- | -------- | ---------------------------------------------- |
| `version`     | yes      | Must be `v1alpha1`                             |
| `steps`       | yes      | Non-empty list                                 |
| `title`       | no       | Picker label; defaults from humanized filename |
| `description` | no       | Picker subtitle                                |
| `hidden`      | no       | Hide from picker; `hwf run` still works        |
| `inputs`      | no       | Entry workflow only prompts                    |
| `returns`     | no       | Child export map or template                   |
| `on_failure`  | no       | Entry-only recovery action                     |

Unsupported format versions fail load with rewrite-or-upgrade guidance. Package stays semver `0.x`; a later incompatible alpha uses `v1alphaN`. Workflow YAML never declares a Herdr version.

## Actions

Exactly one of `agent`, `run`, `herdr`, `workflow` per step. Optional on every step: `id`, `when`, `continue_on_error`.

### `run:`

| Form   | Behavior                                                          |
| ------ | ----------------------------------------------------------------- |
| list   | argv, no shell; templates allowed per element                     |
| string | shell (`sh` on macOS/Linux, `cmd` on Windows) unless `shell:` set |

Natural result: `{stdout, stderr, exit_code, failed}`. Inputs export as `HWF_<name>`. Explicit `env:` cannot use the reserved `HWF_` prefix. Omit `cwd` → invocation cwd. Omit `timeout` → no workflow timeout.

Placed `run:` (`pane.open: beside|below`) preserves the anchor pane via `pane.split`, then submits the argv as a shell-quoted line through `pane.send_input` (Herdr has no socket `pane.run`, and `layout.apply` replaces the tab without preserving live processes). `pane.open: tab` still launches argv directly through `layout.apply`.

Also: `shell`, `cwd`, `env`, `pane`, `background`, `ready_when`, `timeout`, `retry`.

### `agent:`

Prompt text is the `agent:` value. Mutually exclusive `using:` (new managed agent) and `target:` (existing agent).

| Mode                       | Behavior                                        |
| -------------------------- | ----------------------------------------------- |
| `using:` / default profile | Create pane → `agent.start` → `agent.prompt`    |
| `target:`                  | Require idle/done, then prompt; no pane/cwd/env |

Blocking result: `{response, agent, pane_id}`. Turn timeout default 30 minutes; native startup default 30 seconds. `blocked` notifies once per episode and keeps waiting. `unknown` never succeeds.

`{{context.agent}}` is the invoking agent's live name, or its pane ID when Herdr reports no name — agents you start yourself are unnamed, and a pane ID is an accepted target. A workflow that targets `{{context.agent}}` must therefore be launched while that agent is idle or done: `prefix+k` from a settled pane works, asking the agent itself to run it cannot, because the agent is busy serving your request.

Also: `cwd`, `env`, `pane`, `background`, `timeout`.

### `herdr:`

```yaml
- herdr: notification.show
  params:
    title: done
```

No context autofill. Denied methods fail at load. Success result is the complete structured Herdr payload. Also: `params`, `retry`.

### `workflow:`

```yaml
- workflow: child
  inputs:
    branch: "{{inputs.branch}}"
```

Child runs in isolation. Optional child `returns:` become this step's natural result. Child `on_failure` does not run during a parent invocation.

## Pane block

```yaml
pane:
  open: tab # tab | beside | below
  target: "…" # split anchor; default invocation pane
  workspace: "…" # tab workspace; default invocation workspace
  size: 40 # percent for the NEW pane
  focus: true
  close: success # agent-only: success | always
```

`beside` → Herdr right split; `below` → down. Herdr clamps split ratios to 0.1–0.9 (`layout.rs` `valid_split_ratio`), so `pane.size` below 10 or above 90 is clamped. Background processes are pane-owned: they survive client detach, not an ordinary server restart, and are never implicitly stopped after a later workflow failure.

## Readiness

`ready_when: /regex/` on a placed `run:` delegates to `pane.wait_for_output` with source `recent`, 80 rendered rows, ANSI stripped, one logical-line regex. Required `timeout`. Succeeds only on native match. Already-present snapshot text can match. Does not detect process exit.

## Templates

`{{inputs.name}}`, `{{steps.id.field}}`, `{{context.key}}` only. Whole-value templates in structured YAML keep source type; embedded templates render text. `{{prompt}}` is config-only and is not a workflow template.

### Context

| Key                                             | Meaning                                  |
| ----------------------------------------------- | ---------------------------------------- |
| `workspace`, `tab`, `pane`, `worktree`, `agent` | Invocation identity                      |
| `selection`                                     | Selected text (empty if none)            |
| `platform`                                      | `macos` \| `linux` \| `windows`          |
| `transcript`, `transcript_file`                 | Sensitive; fail preflight if unavailable |
| `error`                                         | Recovery only (`on_failure`)             |

## Inputs

Names: `[a-z][a-z0-9_]{0,31}`. Types: `text`, `choice` (static list or `{run: argv}`), `profile` (merged profile names, never args). Choice/profile defaults must exist in available values. Only the entry workflow prompts, in declaration order.

Dynamic choice: argv from repo root, 10s timeout, ≤1,000 options, 8 MiB capture cap.

## Config

```yaml
profiles:
  name:
    kind: claude # non-empty; live agent.start is authoritative
    args: ["--model", "…"] # optional
default_profile: name
transcripts:
  claude:
    command: [extractor, argv…]
```

Layers: global plugin config dir → `.hwf/config.yaml` → `.hwf/config.local.yaml`. Whole-entry replacement by name. No `agents:` or `sessions:`.

## Control flow

| Construct           | Behavior                                                       |
| ------------------- | -------------------------------------------------------------- |
| `when:`             | Scalar truthiness or `==` / `!=`; false → skip (no recovery)   |
| `continue_on_error` | Tolerate failure; suppress recovery; run exits nonzero         |
| `retry`             | Total attempts including first; local `run:` / `herdr:` only   |
| `on_failure`        | Entry-only, once, after first non-tolerated failure            |
| Transport loss      | Stop, keep panes, skip recovery, report uncertain coordination |

## Caps

| Source                                                          | Limit  |
| --------------------------------------------------------------- | ------ |
| Generated `HWF_*` env block                                     | 24 KiB |
| Command / managed response / transcript / dynamic-choice stdout | 8 MiB  |
| Dynamic choices                                                 | 1,000  |
| Dynamic choice timeout                                          | 10s    |
| Transcript extractor timeout                                    | 30s    |

## Trust, share, and import

Workflow files are reviewed executable code. Picker and workbench show repo vs global provenance and flag commands, transcript references, and sensitive Herdr methods.

Sharing uses `hwf workflow import "<bundle>"`: a gzip-compressed, base64-encoded `{name, yaml}[]` array with no version, root, source, or config metadata. Export starts from the exact selected source and walks `workflow:` children with runtime repo-first resolution. Import requires reviewing every YAML body and aggregate warnings, choosing one destination scope for the whole bundle, and confirming. Name conflicts preserve the existing set: workbench asks replace-all interactively; CLI exits with the conflicts and needs `--force` on rerun. The old single-workflow `{v, name, body}` format is rejected. Workbench share/import views never execute workflows.

The method denylist (server/plugin lifecycle, identity authority, experimental graphics, and similar) is an accidental-misuse and runtime-safety rail. It is not a sandbox. Trusted `run:` can invoke the complete Herdr CLI or socket as the current user.

## Portability

v1alpha1 syntax and argv behavior are cross-platform. Runtime capability follows the installed Herdr platform support. Native Windows is beta; use `{{context.platform}}` with `when:` for OS-specific steps.
