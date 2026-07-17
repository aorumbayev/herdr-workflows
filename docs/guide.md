# Guide

herdr ≥ 0.7.4. Plugin sequences short YAML workflows; herdr owns panes/tabs/agents.

## Install & first run

```bash
herdr plugin install @aorumbayev/herdr-workflows
cd your-repo && hwf init          # .hwf/config.yaml + seeded workflows
```

`hwf` ≡ `herdr-workflows`. Install also binds `prefix+k` → picker.

| How                           | What                                             |
| ----------------------------- | ------------------------------------------------ |
| `prefix+k` / `hwf launch`     | picker (filter, pick, optional prompt line)      |
| `hwf run <name> [--prompt …]` | CLI; live step/stderr; best for debug            |
| `hwf` (TTY, no args)          | manage UI: edit workflows/config, browse run log |

Workflow file = `.hwf/workflows/<name>.yaml` (or `~/.hwf/workflows/`; repo wins).

```yaml
# .hwf/workflows/scratch.yaml
steps:
  - open: lazygit
```

`prefix+k` → `scratch` → new tab. Done.

## Config

```yaml
# .hwf/config.yaml  (repo overrides ~/.hwf/config.yaml per name)
agents:
  claude: ["claude", "{prompt}"] # exactly one "{prompt}" argv element
sessions: # optional; stdout → {session}
  # codex: ["sh", "-c", "… $HERDR_WORKFLOWS_SESSION_ID …"]
```

`{session}` resolve order: `sessions:` command → built-in Claude JSONL → error.

## Language

One verb per step. Modifiers only on the right verb. Placeholders **only** in `stdin` / `prompt` / `params` strings — never in `shell:` / `open:` command text (load error).

| Verb    | Blocks | Notes                                                                                        |
| ------- | ------ | -------------------------------------------------------------------------------------------- |
| `shell` | yes    | `sh -c` in repo root; stdout → `{last}`; 300s process-group kill                             |
| `open`  | no*    | new tab; `wait_for: <regex>` blocks (default 60s)                                            |
| `agent` | no*    | config argv; `wait: done` blocks until agent finishes (default 1800s) → `{last}` = pane text |
| `herdr` | no     | socket method; `params`; pane/tab/workspace ids auto-filled                                  |
| `run`   | —      | load-time splice of another workflow                                                         |

\*Without `wait` / `wait_for`, fire-and-forget — `on_fail` cannot see agent/open failure.

| Placeholder   | Value                                                                 |
| ------------- | --------------------------------------------------------------------- |
| `{pane}`      | invocation scrollback (up to 100k lines; capped by herdr retention) |
| `{selection}` | selection text if launched that way                                   |
| `{prompt}`    | picker / `--prompt`                                                   |
| `{last}`      | last `shell` stdout (or agent pane text after `wait: done`)           |
| `{error}`     | failing step + tail; only inside `on_fail` recovery                   |
| `{session}`   | agent transcript; **`stdin` only**                                    |
| `{tab}`       | latest tab opened this run via `agent` / `open`                       |
| `{prev_tab}`  | previous opened tab this run                                          |
| `{agent}`     | invoking pane’s agent label (must match `agents:` key)                |

`agent: "{agent}"` resolves at run time to the invoking pane’s agent.

```yaml
# ✗ load error          # ✓
- shell: echo {pane}    - shell: claude -p "summarize"
                          stdin: "{pane}"
```

### Composition

`run: gate` — include steps (no args; cycles = load error).

`on_fail: handoff` — on first observed failure: one notification, then recovery **once**. Only the entry workflow may declare it. Recovery sees original `{pane}`/`{prompt}`/`{selection}`, plus `{last}` and `{error}`.

## Patterns

```yaml
# gate.yaml
steps:
  - shell: bun test
  - shell: bun run verify

# ship.yaml
on_fail: handoff
steps:
  - run: gate
  - shell: git push

# handoff.yaml
steps:
  - agent: claude
    prompt: |
      Continue from this pane:

      {pane}

      Focus: {prompt}
```

Load errors name file, step, key. Invalid workflows appear greyed in the picker.
