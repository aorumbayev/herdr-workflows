# Reference

Contract for `version: v1alpha1`. The loader enforces cross-field rules. `docs/workflow.schema.json` covers shape only.

## Document

| Key           | Required | Notes                                                                      |
| ------------- | -------- | -------------------------------------------------------------------------- |
| `version`     | yes      | Must be `v1alpha1`                                                         |
| `steps`       | yes      | Non-empty list                                                             |
| `title`       | no       | Picker label. Defaults from humanized filename. Shown up to ~47 chars.     |
| `description` | no       | Picker subtitle. Shown up to ~116 chars (2 lines). Longer values truncated |
| `hidden`      | no       | Hide from picker. `hwf run` still works.                                   |
| `inputs`      | no       | Entry workflow only prompts                                                |
| `returns`     | no       | Child export map or template                                               |
| `on_failure`  | no       | Entry-only recovery action                                                 |

Unsupported format versions fail load with rewrite-or-upgrade guidance. The package stays semver `0.x`. A later incompatible alpha uses `v1alphaN`. Workflow YAML never declares a herdr version.

## Actions

Exactly one of `agent`, `run`, `herdr`, `workflow` per step. Optional on every step: `id`, `when`, `continue_on_error`.

### `run:`

| Form   | Behavior                                                          |
| ------ | ----------------------------------------------------------------- |
| list   | argv, no shell. Templates allowed per element.                    |
| string | shell (`sh` on macOS/Linux, `cmd` on Windows) unless `shell:` set |

Natural result: `{stdout, stderr, exit_code, failed}`. Inputs export as `HWF_<name>`. Explicit `env:` cannot use the reserved `HWF_` prefix. Omit `cwd` to use the invocation cwd. Omit `timeout` for no workflow timeout.

A placed `run:` with `pane.open: beside|below` keeps the anchor pane via `pane.split`. It then submits the argv as a shell-quoted line through `pane.send_input`. herdr has no socket `pane.run`. `layout.apply` replaces the tab and does not keep live processes. `pane.open: tab` still launches argv directly through `layout.apply`.

Also: `shell`, `cwd`, `env`, `pane`, `background`, `ready_when`, `timeout`, `retry`.

### `agent:`

Prompt text is the `agent:` value. `using:` (new managed agent) and `target:` (existing agent) are mutually exclusive.

| Mode                       | Behavior                                         |
| -------------------------- | ------------------------------------------------ |
| `using:` / default profile | Create pane → `agent.start` → `agent.prompt`     |
| `target:`                  | Require idle/done, then prompt. No pane/cwd/env. |

Blocking result: `{response, agent, pane_id}`. Turn timeout default is 30 minutes. Native startup default is 30 seconds. `blocked` notifies once per episode and keeps waiting. `unknown` never succeeds.

`{{context.agent}}` is the invoking agent's live name, or its pane ID when herdr reports no name. Agents you start yourself are unnamed. A pane ID is an accepted target.

A workflow that targets `{{context.agent}}` must start while that agent is idle or done. `prefix+k` from a settled pane works. Asking the agent itself to run it cannot work, because the agent is busy serving your request.

Also: `cwd`, `env`, `pane`, `background`, `timeout`.

### `herdr:`

```yaml
- herdr: notification.show
  params:
    title: done
```

No context autofill. Denied methods fail at load. Success result is the complete structured herdr payload. Also: `params`, `retry`.

### `workflow:`

```yaml
- workflow: child
  inputs:
    branch: "{{inputs.branch}}"
```

The child runs in isolation. Optional child `returns:` become this step's natural result. Child `on_failure` does not run during a parent invocation.

## Pane block

```yaml
pane:
  open: tab # tab | beside | below
  target: "…" # split anchor. Default: invocation pane
  workspace: "…" # tab workspace. Default: invocation workspace
  size: 40 # percent for the NEW pane
  focus: true
  close: success # agent-only: success | always
```

`beside` means a herdr right split. `below` means a down split. herdr clamps split ratios to 0.1–0.9 (`layout.rs` `valid_split_ratio`). Values of `pane.size` below 10 or above 90 are clamped.

Background processes are pane-owned. They survive client detach. They do not survive an ordinary server restart. A later workflow failure does not stop them by default.

## Readiness

`ready_when: /regex/` on a placed `run:` uses `pane.wait_for_output` with source `recent`, 80 rendered rows, ANSI stripped, and one logical-line regex. `timeout` is required. The step succeeds only on a native match. Already-present snapshot text can match. This does not detect process exit.

## Templates

Use `{{inputs.name}}`, `{{steps.id.field}}`, and `{{context.key}}` only. Whole-value templates in structured YAML keep source type. Embedded templates render text. `{{prompt}}` is config-only and is not a workflow template.

### Context

| Key                                             | Meaning                                   |
| ----------------------------------------------- | ----------------------------------------- |
| `workspace`, `tab`, `pane`, `worktree`, `agent` | Invocation identity                       |
| `selection`                                     | Selected text (empty if none)             |
| `platform`                                      | `macos` \| `linux` \| `windows`           |
| `transcript`, `transcript_file`                 | Sensitive. Fail preflight if unavailable. |
| `error`                                         | Recovery only (`on_failure`)              |

## Inputs

Names: `[a-z][a-z0-9_]{0,31}`. Types: `text`, `choice` (static list or `{run: argv}`), `profile` (merged profile names, never args). Choice and profile defaults must exist in available values. Only the entry workflow prompts, in declaration order.

Dynamic choice: argv from repo root, 10s timeout, at most 1,000 options, 8 MiB capture cap.

## Config

```yaml
profiles:
  name:
    kind: claude # non-empty. Live agent.start is authoritative.
    args: ["--model", "…"] # optional
default_profile: name
transcripts:
  claude:
    command: [extractor, argv…]
```

Layers: global plugin config dir, then `.hwf/config.yaml`, then `.hwf/config.local.yaml`. Whole-entry replacement by name. No `agents:` or `sessions:`.

## Control flow

| Construct           | Behavior                                                       |
| ------------------- | -------------------------------------------------------------- |
| `when:`             | Scalar truthiness or `==` / `!=`. False skips (no recovery).   |
| `continue_on_error` | Tolerate failure. Suppress recovery. Run exits nonzero.        |
| `retry`             | Total attempts including first. Local `run:` / `herdr:` only.  |
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

Workflow files are reviewed executable code. The picker and workbench show repo vs global provenance. They flag commands, transcript references, and sensitive herdr methods.

Sharing uses `hwf workflow import "<bundle>"`. The bundle is a gzip-compressed, base64-encoded `{name, yaml}[]` array. It has no version, root, source, or config metadata. Export starts from the exact selected source and walks `workflow:` children with runtime repo-first resolution.

Import requires a review of every YAML body and aggregate warnings. Choose one destination scope for the whole bundle, then confirm. Name conflicts keep the existing set. The workbench asks for replace-all interactively. The CLI exits with the conflicts and needs `--force` on a rerun. The old single-workflow `{v, name, body}` format is rejected. Workbench share and import views never execute workflows.

The method denylist covers server and plugin lifecycle, identity authority, experimental graphics, and similar cases. It is an accidental-misuse and runtime-safety rail. It is not a sandbox. Trusted `run:` can call the complete herdr CLI or socket as the current user.

## Portability

v1alpha1 syntax and argv behavior are cross-platform. Runtime capability follows the installed herdr platform support. Native Windows is beta. Use `{{context.platform}}` with `when:` for OS-specific steps.
