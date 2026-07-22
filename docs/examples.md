# Examples

Copy into `.hwf/workflows/<name>.yaml` (repo) or `~/.hwf/workflows/<name>.yaml` (global; any project). Repo shadows global for the same name.

Agent names come from `.hwf/config.yaml` / `~/.hwf/config.yaml` (or invoking pane via `{agent}`).

Use `{session}` for the agent transcript; `{pane}` when scrollback is enough; `{prompt}` for one focus line; `inputs:` when the user must pick named values (e.g. target agent). Prefer `HWF_INPUT_*` env inside fixed `shell:` commands when driving CLIs — never interpolate `{input.*}` into the command string.

## Handoff (`{session}` + inputs)

`hwf init` can seed this under `~/.hwf/workflows/` (global) or `.hwf/workflows/` (repo). Distill uses the invoking agent (`{agent}`); then opens a chosen target and closes the source tab.

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

`prefix+k` → `handoff` → pick target → focus line (prefilled empty). CLI: `hwf run handoff --input target=<configured-agent>`. Launch from an agent pane.

## Worktree (`HWF_INPUT_*`)

Same init choice — global or repo:

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

Same CLI without a workflow:

```bash
herdr worktree create --branch my-space --base main --label "my space" --focus
```

Do not interpolate `{input.*}` into shell programs, including quoted assignments or heredocs. Workflow substitution is literal text replacement, not shell escaping; untrusted input can change program syntax. Use fixed, author-controlled `shell:` commands and `HWF_INPUT_*` for values.

Quote shell metacharacters in `options:` commands (`%(…)` needs quotes — otherwise `sh -c` treats `(…)` as a subshell). Options commands are workflow-author controlled and must not include user input.
