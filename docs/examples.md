# Examples

Workflows that run in less than a minute. Each card copies a `hwf workflow import "<bundle>"` command.

Paste it into a terminal and run `hwf workflow import`. The CLI shows the full YAML and any warnings before it writes anything, then you pick one destination: this repo or global. Refer to [Run and manage · Import](/surfaces#import-a-workflow).

<ExampleCards />

The files themselves live in [`examples/`](https://github.com/aorumbayev/herdr-workflows/tree/main/examples).

## What to copy from them

- **`branch-check`** is the one to read first. It shows guarded inputs, a custom-value choice, ordered `when:` conditions, and `success_codes` for a command that reports its answer through the exit code.
- **`remote-branch-log`** shows a cascading choice: the second input's options come from a command that reads the first input's answer.
- **`handoff`** shows how to pass your session transcript to an agent.
- **`prompt-enhance`** shows how to read a result back from an agent and use it, and how to pick a clipboard command from the ones the host has.
- **`review-gate`** shows `expect:` on an agent step. The agent ends with one token from `one_of:`, and `{{steps.review.verdict}}` branches the steps after it.
- **`adversarial-revise`** shows two profiles in one run. An author drafts, a critic returns a verdict, and one revision step runs only when the verdict requires it.
- **`worktree`** shows dynamic choice options from commands, raw `herdr:` worktree and tab calls, and a hidden child workflow shared by two paths.
- **`worktree-layout`** is that hidden child. It shows how prior `run:` steps derive a unique agent name for each pane. It shows `retry:` on a herdr `agent.start` call while the shell of the new pane becomes ready. A `when:` guard skips the start when the pane already holds a named agent.

## Tips

- Prefer `run: [cmd, arg]` to the string form. Each item stays one argument, and templates work.
- Read results with `{{steps.id.stdout}}` or `{{steps.id.response}}`. Nothing to declare.
- Add `expect: {one_of: [...]}` to an agent step to get `{{steps.id.verdict}}` as well.
- A background step needs a `pane:` of its own, or a `target:` that points at an agent that already has one.
- Keep `on_failure:` on the workflow you start. A child's own recovery does not run.
