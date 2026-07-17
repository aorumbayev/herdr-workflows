# Examples

Copy into `.hwf/workflows/<name>.yaml`. Agent names come from `.hwf/config.yaml` (or invoking pane via `{agent}`).

## Session handoff (any agent → summarize → continue)

Run from an agent pane. Reads full pane scrollback (`{pane}`), opens a summarizer tab with distill instructions, waits for it, opens a continue tab with that summary, then closes the source tab and the summarizer tab.

Requires: invoking pane’s agent label matches a key under `agents:`. Optional `{prompt}` = focus line.

```yaml
# .hwf/workflows/session-handoff.yaml
on_fail: handoff
steps:
  - agent: "{agent}"
    wait: done
    timeout: 600
    prompt: |
      Distil the pane scrollback below into a handoff prompt for a fresh agent.
      Keep: decisions with rationale, working solutions, changed files with paths,
      discovered constraints, open questions, next steps.
      Drop: corrections, dead ends, verbose tool output, settled back-and-forth.
      Output ONLY the handoff prompt, written as directives to the next agent.
      Focus: {prompt}

      ---
      {pane}
  - agent: "{agent}"
    prompt: "{last}"
  - herdr: tab.close
  - herdr: tab.close
    params:
      tab_id: "{prev_tab}"
```

`prefix+k` → `session-handoff` (optional focus). `on_fail: handoff` falls back to seeded pane-scrollback continue. Summarizer wait uses agent timeout (default 1800s; example sets 600).
