# Reference

Contract for `version: v1alpha1`. The loader enforces cross-field rules. `docs/workflow.schema.json` covers shape only.

## Document

| Key           | Required | Notes                                                                   |
| ------------- | -------- | ----------------------------------------------------------------------- |
| `version`     | yes      | Must be `v1alpha1`                                                      |
| `steps`       | yes      | Non-empty list                                                          |
| `title`       | no       | Picker label. Defaults from humanized filename. Truncated to row width. |
| `description` | no       | Picker subtitle. Wrapped/truncated to row width (at most two lines).    |
| `hidden`      | no       | Hide from picker. `hwf run` still works.                                |
| `inputs`      | no       | Entry workflow only prompts                                             |
| `returns`     | no       | Child export map or template                                            |
| `on_failure`  | no       | Entry-only recovery action                                              |

An unsupported format version fails the load. The error gives rewrite-or-upgrade guidance. The package version stays semver `0.x`. A later, incompatible alpha version uses `v1alphaN`. Workflow YAML never declares a herdr version.

## Actions

Each step uses exactly one of `agent`, `run`, `herdr`, or `workflow`. Every step also accepts the optional fields `id`, `when`, and `continue_on_error`.

### `run:`

| Form   | Behavior                                       |
| ------ | ---------------------------------------------- |
| list   | argv, no shell. Templates allowed per element. |
| string | shell (`sh` unless `shell:` set)               |

The natural result is `{stdout, stderr, exit_code, failed}`. Inputs export as `HWF_<name>` variables. An explicit `env:` entry cannot use the reserved `HWF_` prefix. Omit `cwd` to use the invocation working directory. Omit `timeout` to run without a workflow timeout.

A placed `run:` step with `pane.open: beside` or `pane.open: below` keeps the anchor pane, using `pane.split`. It then submits the argv as a shell-quoted line through `pane.send_input`. herdr has no socket method `pane.run`. `layout.apply` replaces the tab. It does not keep live processes. `pane.open: tab` still launches the argv directly through `layout.apply`.

Also: `shell`, `cwd`, `env`, `pane`, `background`, `ready_when`, `timeout`, `retry`.

### `agent:`

The `agent:` value is the prompt text. `using:` starts a new managed agent. `target:` addresses an existing agent. The two fields are mutually exclusive.

| Mode                       | Behavior                                         |
| -------------------------- | ------------------------------------------------ |
| `using:` / default profile | Create pane → `agent.start` → `agent.prompt`     |
| `target:`                  | Require idle/done, then prompt. No pane/cwd/env. |

The blocking result is `{response, agent, pane_id}`. The default turn timeout is 30 minutes. The default native startup timeout is 30 seconds. A `blocked` state notifies once per episode and keeps waiting. An `unknown` state never succeeds.

`{{context.agent}}` holds the invoking agent's live name. It holds the pane ID instead when herdr reports no name. Agents you start yourself have no name. A pane ID is a valid target.

A workflow that targets `{{context.agent}}` must start while that agent is idle or done. `prefix+k` from a settled pane works. Asking the agent itself to run the workflow cannot work. The agent is busy serving your request.

Also: `cwd`, `env`, `pane`, `background`, `timeout`.

### `herdr:`

```yaml
- herdr: notification.show
  params:
    title: done
```

herdr fills in no context automatically. A denied method fails at load. A success result is the complete structured herdr payload. Also: `params`, `retry`.

### `workflow:`

```yaml
- workflow: child
  inputs:
    branch: "{{inputs.branch}}"
```

The child workflow runs in isolation. An optional child `returns:` value becomes this step's natural result. A child's `on_failure` action does not run during a parent invocation.

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

`beside` opens a herdr right split. `below` opens a down split. herdr clamps split ratios to a range of 0.1 to 0.9 (`layout.rs` `valid_split_ratio`). herdr clamps `pane.size` values below 10 or above 90 to that range.

Background processes are pane-owned. They survive client detach. They do not survive an ordinary server restart. A later workflow failure does not stop them by default.

## Readiness

A `ready_when: /regex/` field on a placed `run:` step uses `pane.wait_for_output`. It reads from source `recent`, across 80 rendered rows, with ANSI codes stripped, using one logical-line regex. `timeout` is required. The step succeeds only on a native match. Text already present in the snapshot can also match. This check does not detect process exit.

## Templates

Use only `{{inputs.name}}`, `{{steps.id.field}}`, and `{{context.key}}`. A whole-value template in structured YAML keeps its source type. An embedded template renders as text. `{{prompt}}` is config-only. It is not a workflow template.

### Context

| Key                                             | Meaning                                          |
| ----------------------------------------------- | ------------------------------------------------ |
| `workspace`, `tab`, `pane`, `worktree`, `agent` | Invocation identity                              |
| `selection`                                     | Selected text (empty if none)                    |
| `platform`                                      | `macos` \| `linux` \| `windows`                  |
| `transcript`, `transcript_file`                 | Sensitive value. Preflight fails if unavailable. |
| `error`                                         | Recovery only (`on_failure`)                     |

## Inputs

A name matches `[a-z][a-z0-9_]{0,31}`. The types are `text`, `choice` (a static list or `{run: argv}`), and `profile` (merged profile names, never args). A closed `choice` or `profile` default must exist among the available values. Mapped inputs may declare ordered `when:` guards that reference earlier inputs. Inactive inputs do not prompt, resolve, or export `HWF_` values. Supplying an inactive value fails collection. A choice may set `allow_custom: true` so listed options are suggestions and other text is accepted. `min_length` is an opt-in non-negative character floor for active values. Only the entry workflow prompts, in declaration order, for inputs that are active under earlier answers. A declared input that is referenced nowhere is a load-time error.

The picker prompt states the input name, the declared `description`, the prompt's ordinal position,
and how to answer: the number of options for a resolved closed domain, whether a custom value is
accepted, and a text input's default and `min_length`. Answers collected so far are listed below the
prompt, so a guarded domain explains itself. Describe every input — the description is the only part
of that line an author controls.

Migration: scripted `hwf run` callers must omit `--input` flags for inactive inputs. Placeholder values such as `--input branch=` now fail when an earlier answer makes `branch` inactive.

A dynamic choice runs its argv from the repo root, with a 10-second timeout, a limit of 1,000 options, and an 8 MiB capture cap. Discovery argv must stay template-free and must not depend on earlier answers. Loading and listing validate declarations without executing discovery. Entry collection executes only active dynamic choices, at most once. Picker launches carry the resolved domains on the stdin payload so the detached run does not re-execute them. Treat discovery commands as read-only.

Inspect declarations without running steps:

```bash
hwf workflow inspect <name>
hwf workflow inspect <name> --input mode=delete --resolve
```

Without `--resolve`, dynamic argv is printed and not executed. With `--resolve`, only active dynamic choices run under the ordinary limits.

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

The layers are the global plugin config directory, then `.hwf/config.yaml`, then `.hwf/config.local.yaml`. Each layer replaces whole entries by name. There is no `agents:` or `sessions:` key.

## Control flow

| Construct           | Behavior                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `when:`             | One clause or a non-empty ordered list. Short-circuit AND. Truthiness or `==` / `!=`. False skips |
| Guarded results     | Conditional inputs and step results need matching consumer `when:` clauses (structural equality)  |
| `success_codes`     | Blocking local `run:` only. Listed exit codes succeed. Default `[0]`. Placed/background reject it |
| `continue_on_error` | Tolerate failure. Suppress recovery. Run exits nonzero.                                           |
| `retry`             | Total attempts including first. Local `run:` / `herdr:` only.                                     |
| `on_failure`        | Entry-only, once, after first non-tolerated failure                                               |
| Transport loss      | Stop, keep panes, skip recovery, report uncertain coordination                                    |

`pane.open` may be a whole-value `{{inputs.place}}` reference when `place` is an unconditional closed static choice whose every option is `tab`, `beside`, or `below`.

## Caps

| Source                                                          | Limit  |
| --------------------------------------------------------------- | ------ |
| Generated `HWF_*` env block                                     | 24 KiB |
| Agent prompt body (inline)                                      | 16 KiB |
| Command / managed response / transcript / dynamic-choice stdout | 8 MiB  |
| Dynamic choices                                                 | 1,000  |
| Dynamic choice timeout                                          | 10s    |
| Transcript extractor timeout                                    | 30s    |

Oversized agent prompts spill to a file; the agent receives a pointer instruction to read that path.

## Trust, share, and import

A workflow file is reviewed executable code. The picker and the workbench show repo or global provenance. They flag commands, transcript references, and sensitive herdr methods.

Sharing uses the command `hwf workflow import "<bundle>"`. The bundle is a gzip-compressed, base64-encoded `{name, yaml}[]` array. It carries no version, root, source, or config metadata. Export starts from the exact selected source. It walks `workflow:` children using the same repo-first resolution as runtime.

The CLI import accepts that command or the encoded bundle only. The workbench `#import` view also accepts a single raw workflow YAML document with an explicit name. Both require a review of every YAML body and the aggregate warnings, then one destination scope. A name conflict keeps the existing entry until replace-all (workbench prompt) or `--force` (CLI rerun). The old single-workflow `{v, name, body}` format is rejected. The workbench list exposes Import beside New; a saved workflow's editor exposes Share. Share and import never execute workflows.

The method denylist covers server and plugin lifecycle, identity authority, experimental graphics, and similar cases. It guards against accidental misuse and protects runtime safety. It is not a sandbox. A trusted `run:` step can call the complete herdr CLI or socket as the current user.

## Portability

v1alpha1 syntax and argv behavior work on the supported platforms (Linux and macOS; Windows via WSL2). Runtime capability follows the installed herdr. Omitted `shell:` for string `run:` defaults to `sh`. Use `{{context.platform}}` with `when:` for OS-specific steps — that is the only workflow-level OS selection.
