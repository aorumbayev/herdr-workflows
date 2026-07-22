# Examples

Copy into `.hwf/workflows/<name>.yaml`. Agent names come from `.hwf/config.yaml` (or invoking pane via `{agent}`).

Use `{session}` for the agent transcript; `{pane}` when scrollback is enough; `{prompt}` for one focus line; `inputs:` when the user must pick named values (e.g. target agent). Prefer `HWF_INPUT_*` env inside fixed `shell:` commands when driving CLIs — never interpolate `{input.*}` into the command string.

## Handoff (`{session}` + inputs)

Summarize the invoking agent session, then open a chosen agent with that handoff. Seeded `handoff` uses first detected configured agent for summary and closes the source tab after the target opens.

```yaml
# .hwf/workflows/handoff.yaml
inputs:
  target:
    options: agents
    label: hand over to
  focus:
    default: ""
steps:
  - shell: cat
    stdin: "{session}"
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
    close_source: true
```

`prefix+k` → `handoff` → pick target → focus line (prefilled empty). CLI: `hwf run handoff --input target=<configured-agent>`.

## Worktree (`HWF_INPUT_*`)

Seeded `worktree` collects branch/base, then calls herdr with env-exported inputs:

```yaml
# .hwf/workflows/worktree.yaml
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
