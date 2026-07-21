# Guide

herdr ≥ 0.7.4. Plugin sequences short YAML workflows; herdr owns panes/tabs/agents.

## Install & first run

```bash
herdr plugin install aorumbayev/herdr-workflows
cd your-repo && hwf init          # .hwf/config.yaml + seeded workflows
```

`hwf` ≡ `herdr-workflows`. Install also binds `prefix+k` → picker.

| How                                           | What                                             |
| --------------------------------------------- | ------------------------------------------------ |
| `prefix+k` / `hwf launch`                     | picker (filter, pick, optional prompt line)      |
| `hwf run <name> [--prompt …] [--input k=v …]` | CLI; live step/stderr; best for debug            |
| `hwf` (TTY, no args)                          | manage UI: edit workflows/config, browse run log |

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
```

Optional `sessions:` maps agent → argv whose stdout fills `{session}` (see [Reference](/reference#config)). Built-in Claude JSONL applies when unset.

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

`shell:` = headless blocking command (stdout → `{last}`, no tab). `agent:` = config agent in a new tab. Use `shell:` for one-shot LLM CLIs (`claude -p`); use `agent:` when you want an interactive pane.

| Placeholder      | Value                                                               |
| ---------------- | ------------------------------------------------------------------- |
| `{pane}`         | invocation scrollback (up to 100k lines; capped by herdr retention) |
| `{selection}`    | selection text if launched that way                                 |
| `{prompt}`       | picker / `--prompt`                                                 |
| `{last}`         | last `shell` stdout (or agent pane text after `wait: done`)         |
| `{error}`        | failing step + tail; only inside `on_fail` recovery                 |
| `{session}`      | agent transcript; **`stdin` only**                                  |
| `{session_file}` | path to transcript temp file (deleted after run); **`stdin` only**  |
| `{tab}`          | latest tab opened this run via `agent` / `open`                     |
| `{prev_tab}`     | previous opened tab this run                                        |
| `{agent}`        | invoking pane’s agent label (must match `agents:` key)              |
| `{input.<name>}` | declared workflow input; collected by picker or `--input`           |

```yaml
# ✗ load error          # ✓
- shell: echo {pane}    - shell: claude -p "summarize"
                          stdin: "{pane}"
```

### Inputs

`{prompt}`, declared `inputs:`, and `{session}` are all first-class — pick by job: one ad hoc focus line → `{prompt}` / `--prompt`; named fields or choices → `inputs:`; agent transcript → `{session}` in `stdin`.

Picker asks one screen per declared input (choice list with type-to-filter, or text line), then the `{prompt}` line if used. CLI: `--input name=value` (repeatable). Exact load rules: [Reference](/reference#inputs).

```yaml
inputs:
  target:
    options: agents # builtin → config agent names
  branch:
    options: "git branch --format='%(refname:short)'" # shell → stdout lines
  focus:
    label: focus area
    default: "" # picker prefill / CLI fallback when --input omitted
steps:
  - agent: "{input.target}"
    prompt: "Branch {input.branch}\nFocus: {input.focus}\n\n{pane}"
```

| `options:`        | Meaning                                                       |
| ----------------- | ------------------------------------------------------------- |
| omitted           | free text                                                     |
| `[a, b, …]`       | literal choices                                               |
| `agents`          | builtin — config agent names                                  |
| `"shell command"` | run in repo cwd; non-empty stdout lines → choices (load time) |

| `agent:` value     | Resolves to                                       |
| ------------------ | ------------------------------------------------- |
| `claude`           | that config agent                                 |
| `"{agent}"`        | invoking pane’s agent label                       |
| `"{input.target}"` | choice input; every option must be a config agent |

`default` prefills (text) or preselects (choice) in the picker — it does not skip the screen. CLI may omit `--input` only when a default exists (`hwf run … --input target=<configured-agent>` if `focus` has `default: ""`).

### Composition

`run: gate` — include steps (no args; cycles = load error).

`on_fail: continue` — on first observed failure: one notification, then recovery **once**. Only the entry workflow may declare it. Recovery may reference entry `{input.*}` values; it may not declare its own `inputs:`. Recovery sees the original invocation placeholders (`{pane}` / `{prompt}` / `{selection}` / `{session}` / `{agent}` / inputs), plus `{last}` and `{error}`.

## Patterns

```yaml
# gate.yaml
steps:
  - shell: bun test
  - shell: bun run verify

# ship.yaml
on_fail: continue
steps:
  - run: gate
  - shell: git push

# continue.yaml  (recovery; no inputs:)
steps:
  - agent: claude
    prompt: |
      Continue from this pane:

      {pane}

      Focus: {prompt}

# handoff.yaml  (seeded by hwf init)
inputs:
  target:
    options: agents
    label: hand over to
  focus:
    default: ""
steps:
  - shell: cat
    stdin: "{pane}"
  - agent: claude # hwf init uses its first detected configured agent
    prompt: |
      Distil the transcript below into a handoff prompt.
      Output ONLY the handoff prompt.
      ---
      {last}
    wait: done
    timeout: 900
  - agent: "{input.target}"
    prompt: |
      Focus: {input.focus}

      {last}
```

Load errors name file, step, key. Invalid workflows appear greyed in the picker.
