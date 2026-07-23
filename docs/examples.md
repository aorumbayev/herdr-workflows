# Examples

Copy into `.hwf/workflows/<name>.yaml` (repo) or `~/.hwf/workflows/<name>.yaml` (global, every project). Ordered simple → complex.

## Scratch — open a tool

The smallest useful workflow: a new tab running a command.

```yaml
# scratch.yaml
steps:
  - open: lazygit
```

`prefix+k` → `scratch` → enter.

## Gate & ship — compose, recover on failure

`gate` runs checks; `ship` reuses them and pushes; if anything fails, `continue` hands the pane to an agent.

```yaml
# gate.yaml
steps:
  - shell: bun test
  - shell: bun run verify
```

```yaml
# ship.yaml
on_fail: continue
steps:
  - run: gate
  - shell: git push
```

```yaml
# continue.yaml  (recovery — no inputs: allowed)
steps:
  - agent: claude
    prompt: |
      Continue from this pane:

      {pane}

      Focus: {prompt}
```

## Inputs — ask the user

Choice from a shell command, plus a free-text field with a default.

```yaml
# discuss.yaml
inputs:
  branch:
    options: "git branch --format='%(refname:short)'"
  focus:
    default: ""
steps:
  - agent: claude
    prompt: "Branch {input.branch}\nFocus: {input.focus}\n\n{pane}"
```

Picker: two screens, then run. CLI: `hwf run discuss --input branch=main`.

## Worktree — inputs via `HWF_INPUT_*` env

Seeded by `hwf init`. Values reach the CLI through environment variables, not interpolation:

```yaml
# worktree.yaml
inputs:
  branch:
    label: new branch name
  base:
    options: [main, develop]
    default: main
steps:
  - shell: herdr worktree create --branch "$HWF_INPUT_branch" --base "$HWF_INPUT_base" --label "$HWF_INPUT_branch" --focus
```

Never put `{input.*}` inside the `shell:` command string — substitution is literal text replacement, not shell escaping, so crafted input could rewrite your command. Fixed command text + env vars for values.

## Handoff — distill one agent session into another

Seeded by `hwf init`. Run it from an agent pane: distils the current session (`{session}`) with the invoking agent (`{agent}`), then opens the chosen target and closes the source tab.

```yaml
# handoff.yaml
inputs:
  target:
    options: agents
    label: hand over to
  focus:
    default: ""
steps:
  - shell: cat
    stdin: "{session}"
  - agent: "{agent}"
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
    close_source: true
```

CLI: `hwf run handoff --input target=<configured-agent>`. `{session}` works in `stdin` only; non-Claude agents need a `sessions:` entry in config (see [Reference](/reference#config)).
