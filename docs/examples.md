# Examples

Three workflows you can have running in under a minute. Each card copies a `hwf workflow import "<bundle>"` command.

Paste it into a terminal, or into the **Import** view of `hwf web`. You'll see the full YAML and any warnings before anything is written, then you pick one destination: this repo or global. See [Run and manage · Import](/surfaces#import-a-workflow).

<ExampleCards />

The files themselves live in [`examples/`](https://github.com/aorumbayev/herdr-workflows/tree/main/examples).

## What to copy from them

- **`branch-check`** is the one to read first. It shows guarded inputs, a custom-value choice, ordered `when:` conditions, and `success_codes` for a command that reports its answer through the exit code.
- **`handoff`** shows passing your session transcript to an agent.
- **`prompt-enhance`** shows reading a result back out of an agent and using it.

## Tips

- Reach for `run: [cmd, arg]` over the string form. Each item stays one argument, and templates work.
- Read results with `{{steps.id.stdout}}` or `{{steps.id.response}}`. Nothing to declare.
- A background step needs a `pane:` of its own, or a `target:` pointing at an agent that already has one.
- Keep `on_failure:` on the workflow you start. A child's own recovery doesn't run.
