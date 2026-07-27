# Guide

Linear path from install to writing your own workflows. Lookup tables live in the [Reference](/reference).

## Install

Needs [herdr](https://herdr.dev) ≥ 0.7.5.

```bash
herdr plugin install aorumbayev/herdr-workflows
```

That compiles the plugin, puts `hwf` (≡ `herdr-workflows`) on your PATH, and binds `prefix+k` to the picker.

## Set up a repo

```bash
cd your-repo
hwf init
```

Writes `.hwf/config.yaml` with native Herdr profiles for agent kinds found on your PATH. No workflows yet: pick ready-made ones from [Examples](/examples). Each card copies a `hwf workflow import "<base64>"` command. Import prints the full YAML, flags commands, transcript use, and sensitive Herdr methods, asks for explicit confirmation, then writes into this repo's `.hwf/workflows` or your global `~/.hwf/workflows`.

Workflow YAML is reviewed executable code. Merely opening a repository never runs a workflow. There is no sandbox — a trusted `run:` can invoke the whole Herdr CLI or socket as your user.

## Run your first workflow

```yaml
# .hwf/workflows/scratch.yaml
version: v1alpha1
steps:
  - run: [lazygit]
    pane:
      open: tab
    background: true
```

- `prefix+k` → type `scratch` → enter.
- From a terminal: `hwf run scratch`.
- Workflows live in `.hwf/workflows/` (repo) or `~/.hwf/workflows/` (global). Repo shadows global on the same name.

Minimal document:

```yaml
version: v1alpha1
steps:
  - run: [bun, test]
```

## Pick a surface

| Where                     | Use it for                                                   |
| ------------------------- | ------------------------------------------------------------ |
| `prefix+k` (picker)       | running — collects entry inputs, then fires                  |
| `hwf run <name>`          | running from scripts/terminal, with `--input k=v`            |
| `hwf web` (or bare `hwf`) | editing — browser workbench: build, validate, share, run log |

Running always goes through the picker or `hwf run`. The workbench builds and shares but never executes.

## Format

Every workflow declares `version: v1alpha1`. The package stays semver `0.x`; a later incompatible alpha increments `v1alphaN`. Workflow YAML never declares a Herdr version — the plugin manifest and CLI own that.

Optional `title` and `description` appear in the picker (title defaults from the humanized filename). `hidden: true` hides a workflow from the picker but still allows `hwf run`.

## Four actions

Exactly one action key per step:

| Action      | Role                                                                   |
| ----------- | ---------------------------------------------------------------------- |
| `run:`      | local argv or shell command → `{stdout, stderr, exit_code, failed}`    |
| `agent:`    | managed native agent turn → `{response, agent, pane_id}` when blocking |
| `herdr:`    | explicit socket method + `params:` → that method's structured result   |
| `workflow:` | isolated child workflow with its own inputs and optional `returns:`    |

Templates use `{{inputs.*}}`, `{{steps.<id>.*}}`, and `{{context.*}}` only. Results are automatic and structured — there is no `out:` binding.

## Profiles and config

Config accepts only `profiles`, `default_profile`, and `transcripts`. A profile is `{ kind, args? }`. Live Herdr `agent.start` is authoritative for which kinds work.

Layers (whole-entry replacement by name):

1. `$HERDR_PLUGIN_CONFIG_DIR/config.yaml` (discovered via `herdr plugin config-dir` when standalone)
2. committed `.hwf/config.yaml`
3. gitignored `.hwf/config.local.yaml`

```yaml
# .hwf/config.yaml
profiles:
  claude:
    kind: claude
  deep:
    kind: claude
    args: ["--model", "opus"]
default_profile: claude
```

## Managed agents

```yaml
- agent: |
    Review {{context.selection}}
  using: deep
  pane:
    open: beside
    size: 40
```

- `using:` starts a new managed agent in a created pane (profile kind/args → `agent.start`, then `agent.prompt`).
- `target:` prompts an existing recognized agent that must already be `idle` or `done`. Busy targets fail before submission — use `herdr: agent.prompt` if you intentionally want to queue.

Blocking turns append a managed response-file instruction and wait for that non-empty file plus `idle`/`done`. Result is `{response, agent, pane_id}` where `agent` is native Herdr AgentInfo. `blocked` notifies once per episode and keeps waiting. `unknown` never settles successfully. Turn timeout defaults to 30 minutes; native startup keeps its own 30-second default.

Background agent or placed `run:` needs a Herdr-owned pane (or an existing-agent `target:`). Pane-owned processes survive client detach, are not stopped after a later workflow failure, and do not survive an ordinary server restart.

## Panes and readiness

Nested `pane:` on `agent:` / `run:`:

```yaml
pane:
  open: beside # tab | beside | below
  size: 40 # percent for the NEW pane (1–99)
  focus: true
  close: success # agent-only: success | always
```

Anchors are the immutable invocation pane/workspace or explicit `target` / `workspace` — never live UI focus. `beside` maps to Herdr's right split, `below` to down. Herdr clamps split ratios to 0.1–0.9, so a `pane.size` below 10 or above 90 is clamped rather than honored exactly.

`ready_when: /regex/` on a placed `run:` waits through native `pane.wait_for_output` over the recent 80 rendered rows with ANSI stripped. Already-present snapshot text can match. It does not detect process exit. `timeout` is required with `ready_when`.

## Context and transcripts

`context` carries invocation `workspace`, `tab`, `pane`, `worktree`, `agent`, `selection`, `platform`, plus `transcript` / `transcript_file` when the workflow references them. Identity and transcript values that are unavailable fail preflight.

Transcript extraction is kind-keyed under `transcripts:` (or built-in support). Referencing transcript context sends capped text to the selected profile's provider. Import and the workbench mark transcript references as sensitive. There is no per-run transcript confirmation and no sandbox claim.

## Control flow

- Scalar `when:` — whole-value truthiness or `==` / `!=` text comparison
- `continue_on_error: true` — record failure, continue, suppress recovery; run still exits nonzero
- `retry: { attempts, delay? }` — only on blocking local `run:` or `herdr:`
- Entry-only `on_failure:` — one recovery action after the first non-tolerated failure
- Unexpected Herdr transport loss after dispatch is uncertain coordination loss: stop, keep panes, skip recovery

## Caps

| Limit                                                    | Value      |
| -------------------------------------------------------- | ---------- |
| Generated `HWF_*` environment                            | 24 KiB     |
| Command / response / transcript / dynamic-choice capture | 8 MiB      |
| Dynamic choices                                          | 1,000; 10s |
| Transcript extractors                                    | 30s        |

Crossing a cap fails naming the source and limit — never truncate.

## Trust

Repo workflows carry the repository's script trust. Imported global workflows show full YAML and require confirmation before writing. The Herdr method denylist blocks accidental server/plugin/identity misuse at load time; it is **not** an authorization boundary. Trusted `run:` can call the complete Herdr CLI or socket as the current user.
