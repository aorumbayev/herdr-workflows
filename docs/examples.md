# Examples

Copy into `.hwf/workflows/<name>.yaml`. Agent names come from `.hwf/config.yaml` (or invoking pane via `{agent}`).

Use `{session}` for the agent transcript; `{pane}` when scrollback is enough; `{prompt}` for one focus line; `inputs:` when the user must pick named values (e.g. target agent).

## Handoff (`{pane}` + inputs)

Summarize the invoking pane, then open a chosen agent with that handoff. Seeded `handoff` uses first detected configured agent for summary.

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

`prefix+k` → `handoff` → pick target → focus line (prefilled empty). CLI: `hwf run handoff --input target=<configured-agent>`.

## Worktree space

Create named worktrees with herdr directly:

```bash
herdr worktree create --branch my-space --base main --label "my space" --focus
```

Do not interpolate `{input.*}` into shell programs, including quoted assignments or heredocs. Workflow substitution is literal text replacement, not shell escaping; untrusted input can change program syntax. Use only fixed, author-controlled `shell:` commands. Input-driven shell automation needs an argv/env data-passing interface, which this workflow format does not provide.

Quote shell metacharacters in `options:` commands (`%(…)` needs quotes — otherwise `sh -c` treats `(…)` as a subshell). Options commands are workflow-author controlled and must not include user input.
