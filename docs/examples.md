# Examples

Workflows that run in less than a minute. Each card copies a `hwf workflow import "<bundle>"` command. Paste it into a terminal. The CLI shows the YAML and any warnings, then prompts for a destination. Refer to [Import a workflow](/surfaces#import-a-workflow).

<ExampleCards />

The files live in [`examples/`](https://github.com/aorumbayev/herdr-workflows/tree/main/examples).

## What each one shows

| Example              | Shows                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `branch-check`       | Read this one first. Guarded inputs, a custom-value choice, ordered `when:`, and `success_codes`        |
| `remote-branch-log`  | A cascading choice. The options of the second input come from the answer to the first                  |
| `handoff`            | Passes your session transcript to an agent                                                             |
| `prompt-enhance`     | Reads the response of an agent and uses it, and selects a clipboard command from the ones the host has |
| `review-gate`        | `expect:` on an agent step. `{{steps.review.verdict}}` branches the steps after it                     |
| `adversarial-revise` | Two profiles in one run. An author drafts, a critic returns a verdict, and a `when:` guard on one revision step |
| `worktree`           | Dynamic options from commands, raw `herdr:` worktree and tab calls, and a hidden child shared by two paths |
| `worktree-layout`    | That hidden child. A unique agent name per pane, `retry:` on `agent.start`, and a `when:` guard        |

The [guide](/guide) explains each pattern.
