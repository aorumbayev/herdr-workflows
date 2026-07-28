# Examples

Each card on this page copies a `hwf workflow import "<base64>"` command. Import prints the full YAML, marks commands, transcript access, and sensitive Herdr methods, asks for confirmation, then writes into repo or global `.hwf/workflows`.

All shipped examples use `version: v1alpha1`.

## Handoff

Distils `{{context.transcript}}` on the invoking agent (`target:`), announces the result, opens the destination profile in a new background tab, then closes the originating tab.

Transcript access is intentional reviewed YAML. Import flags that reference before you confirm.

```yaml
version: v1alpha1
title: Handoff
description: Distil this session and hand it to another agent
inputs:
  target: profile
  focus:
    type: text
    default: ""
on_failure:
  herdr: notification.show
  params:
    title: handoff failed
    body: "{{context.error.message}}"
    sound: request
steps:
  - id: brief
    agent: |
      Distil the transcript below the --- marker into a handoff prompt for a
      fresh agent session. Keep decisions, solutions, file paths, and open
      questions; drop retries and verbose tool output.

      ---
      {{context.transcript}}
    target: "{{context.agent}}"
    timeout: 15m

  - herdr: notification.show
    params:
      title: handoff ready
      body: "opening {{inputs.target}}"
      sound: done

  - agent: |
      Focus: {{inputs.focus}}

      {{steps.brief.response}}
    using: "{{inputs.target}}"
    background: true
    pane:
      open: tab

  - herdr: tab.close
    params:
      tab_id: "{{context.tab}}"
    continue_on_error: true
```

## Prompt enhance

Rewrites prompt text in a managed pane that closes on success, copies the managed `response` to the clipboard (`pbcopy` / `xclip` by platform), and notifies.

```yaml
version: v1alpha1
title: Prompt enhance
description: Refine a prompt in a managed pane, then copy the result to the clipboard
inputs:
  target: profile
  text: text
on_failure:
  herdr: notification.show
  params:
    title: prompt-enhance failed
    body: "{{context.error.message}}"
    sound: request
steps:
  - id: refined
    agent: |
      Improve the supplied text; do not perform the task it describes. Return
      only the rewritten text.

      ---
      {{inputs.text}}
    using: "{{inputs.target}}"
    timeout: 10m
    pane:
      open: beside
      focus: false
      close: success

  - run: [sh, -c, 'printf %s "$TEXT" | pbcopy']
    env:
      TEXT: "{{steps.refined.response}}"
    when: '{{context.platform}} == "macos"'

  - run: [sh, -c, 'printf %s "$TEXT" | xclip -selection clipboard']
    env:
      TEXT: "{{steps.refined.response}}"
    when: '{{context.platform}} != "macos"'

  - herdr: notification.show
    params:
      title: prompt ready
      body: refined prompt copied to clipboard
      sound: done
```

## Authoring tips

- Prefer argv-form `run: [cmd, arg]` for values that must be arguments.
- Use `{{steps.id.response}}` / `{{steps.id.stdout}}` — results are automatic.
- Background work needs a Herdr-owned `pane:` (or an existing-agent `target:`).
- Keep recovery on the entry workflow's `on_failure:` only.
