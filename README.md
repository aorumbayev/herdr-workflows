<h3 align="center">
  <img src="docs/assets/logo.svg" width="80" alt="herdr-workflows" /><br />
  herdr-workflows
</h3>

<p align="center">Automate repetitive work in herdr</p>

<p align="center">
  <a href="https://aorumbayev.github.io/herdr-workflows/install">Install</a> · <a href="https://aorumbayev.github.io/herdr-workflows/guide">Guide</a> · <a href="https://aorumbayev.github.io/herdr-workflows/examples">Examples</a>
</p>

<p align="center">
  <img src="docs/assets/workbench.svg" alt="herdr-workflows overview" width="900" />
</p>

---

You retype the same sequence every day: run the tests, read the diff, ask an agent to review it. herdr-workflows is a [herdr](https://herdr.dev) plugin that writes that sequence once, as a short YAML file, and starts it from a hotkey. Each step does one of four things:

| Step        | What it does                                        |
| ----------- | --------------------------------------------------- |
| `run:`      | Runs a local command and captures its output        |
| `agent:`    | Starts a coding agent, sends a prompt, waits for it |
| `herdr:`    | Calls one herdr API method                          |
| `workflow:` | Runs another workflow as a child                    |

```yaml
# .hwf/workflows/review.yaml
version: v1alpha1
steps:
  - id: diff
    run: [git, diff, HEAD]
  - agent: |
      Review this diff. Blocking issues only.

      {{steps.diff.stdout}}
    using: claude
    when: "{{steps.diff.stdout}}"
    pane:
      open: beside
```

This workflow reads your diff, then opens Claude in a split pane for a review. It skips the review when the diff is empty. Press `prefix+k` to run it.

> [!IMPORTANT]
> A workflow file is code that you choose to run. There is no sandbox. Read a workflow before you run it, especially one that another person shared.

## Install

You need [herdr](https://herdr.dev) 0.8.2 or later on Linux or macOS. Windows uses WSL2.

```bash
herdr plugin install aorumbayev/herdr-workflows
cd your-repo
hwf init
```

`hwf init` writes the agents on your `PATH` into `.hwf/config.yaml` as profiles. The [install page](https://aorumbayev.github.io/herdr-workflows/install) covers PATH setup, updates, and config layers.

## Ways to work

| Command or key   | What it is for                                              |
| ---------------- | ----------------------------------------------------------- |
| `prefix+k`       | Pick and run a workflow. `Ctrl+P` opens the actions palette |
| `hwf run <name>` | Run from a terminal or a script, with `--input name=value`  |
| `hwf console`    | Full-screen console with diagrams and run history           |
| `hwf help`       | List every command                                          |

[Run and manage](https://aorumbayev.github.io/herdr-workflows/surfaces) covers the rest.

## Build workflows with your agent

Run `hwf skills show herdr-workflow-create` and hand the text to your agent. The [guide](https://aorumbayev.github.io/herdr-workflows/guide#build-with-an-agent) has a prompt to paste.

## Docs

- [Documentation](https://aorumbayev.github.io/herdr-workflows/)
- [Contributing](CONTRIBUTING.md)

## License

MIT
