# Run and manage

The picker launches workflows and opens the console. Use the CLI to script runs, import bundles, and validate YAML. A run needs real herdr panes.

## The picker

Press `prefix+k`. The overlay has three tabs: workflows, runs, and profiles. `Tab` and `Shift+Tab` cycle them. The footer of each tab lists its keys. Type to filter by title or file name. Text fields accept a clipboard paste. Newlines become spaces, and the picker refuses a paste of more than 16 KiB.

Each workflow row shows the title, a `!` marker when the workflow does something sensitive, and `repo`, `global`, or `invalid`. When you select a workflow, its description and its sensitivity flags show below the list. Select an `invalid` workflow to read the load error. With no workflows, the picker points you to the actions palette.

While the picker prompts for inputs, each question shows its name and description above the options. A faint line shows your progress and earlier answers. Press `Escape` to return to the previous question. If you change an earlier answer, the picker drops the later ones.

### Runs

The runs tab defaults to the current checkout root. `Ctrl+G` toggles an All scope across retained checkouts. Each row shows the status, the workflow, the progress, and the elapsed time. `Enter` opens a detail view. `Escape` returns to the list, and an active run continues. In the detail view, `r` retries all steps and `f` retries from the failed step. Refer to [Retry a run](#retry-a-run).

A launch shows `STARTING`, then closes the popup when the run starts. A launch that fails keeps the popup open with the reason. A run is `RUNNING` while it reports progress, and `STALE` after fifteen seconds of silence. Stale is not failure. Run history stays in a private local database.

### Profiles

The profiles tab lists every profile across the configuration layers, with its source: `global`, `repo`, or `local`. Select a profile to read its kind and args. `Enter` opens the `config.yaml` that defines it in `$EDITOR`, and the picker validates the configuration when the editor closes. `Ctrl+P` offers `n` to create a profile in a layer you select, and `o` to open the selected one. Edit or delete a profile by hand.

### Actions palette

In the workflows tab, press `Ctrl+P`. One letter fires the action. `Escape` closes the palette. `e`, `s`, and `d` need a selected valid workflow.

| Key | Action                                                                      |
| --- | --------------------------------------------------------------------------- |
| `n` | Create a workflow, after a chooser: build with an agent, or edit a template |
| `i` | Show the `hwf workflow import` hint                                         |
| `o` | Open the examples page in your browser                                      |
| `c` | Open the console, after a placement chooser                                 |
| `e` | Edit the selected workflow in `$EDITOR`, then validate it                   |
| `s` | Copy the import command of the selected workflow                            |
| `d` | Delete the selected workflow, after a `y` or `n` confirmation               |

**Build with an agent** types a handoff prompt into a herdr agent pane. With more than one pane, select one. Each row shows the workspace and tab labels, a status glyph, the agent kind and title, the pane ID, and `(you)` on your own pane. The glyphs are `*` busy, `-` idle, `!` blocked, `?` unknown. The pane ID is always shown, so two agents in one tab stay distinct. The prompt tells the agent to obey the `herdr-workflow-create` skill and to interview you first. The picker types the prompt and does not submit it. Press `Enter` in the pane to start.

**Edit a template** writes a skeleton. Enter a name, select the repo or the global level, then select where the editor opens: `popup`, `beside`, `below`, or `tab`.

## The console

Open the console from the picker: `Ctrl+P`, then `c`, then a placement. `beside` is the default. From a selected workflow, the console opens on the diagram of that workflow.

`Tab` cycles the workflows list and the runs list. `Enter` on a workflow opens a read-only diagram of its steps, its `when:` edges, and its pane targets. On the diagram, `v` selects step nodes and `s` sends the selected YAML plus your instruction into an agent pane input, without a submit. `Enter` on a run opens debug tabs: `1` log, `2` transcript, `3` yaml-at-run. `y` copies `hwf retry <run-id>` and `Y` copies `hwf retry <run-id> --from-failed`, without a submit. `Escape` returns.

`hwf console` runs the console in the current terminal. `hwf console --placement <tab|beside|below>` opens it in a pane, or in the terminal when no pane host is available.

## The CLI

| Command                                | What it does                                                          |
| -------------------------------------- | --------------------------------------------------------------------- |
| `hwf run <name>`                       | Runs a workflow. `--input name=value`, repeatable                     |
| `hwf retry <run-id>`                   | Runs a recorded run again with its inputs. `--from-failed`            |
| `hwf workflow inspect <name>`          | Prints what a workflow prompts for. `--input`, `--resolve`            |
| `hwf workflow validate <file>`         | Validates a YAML file through the loader. Prints JSON, exits 0 or 1   |
| `hwf workflow import "<...>"`          | Imports a shared bundle. `--to repo\|global`, `--yes`, `--force`      |
| `hwf init`                             | Writes config. `--global`, `--force`                                  |
| `hwf launch`                           | Opens the picker popup                                                |
| `hwf picker`                           | Runs the picker in the current terminal                               |
| `hwf console`                          | Runs the console, or opens it with `--placement`                      |
| `hwf update`                           | Installs the latest published release                                 |
| `hwf skills list`, `hwf skills show`   | Lists or prints the bundled agent skills                              |
| `hwf scratch <get\|set\|list\|delete>` | Reads and writes the scratch store. Refer to [Scratch](/reference#scratch) |
| `hwf response check <file>`            | Checks the verdict line of a response file. `--one-of TOKEN,TOKEN`    |
| `hwf help [command]`, `hwf --version`  | Shows help, or prints the plugin version                              |

`hwf` and `herdr-workflows` are the same command. Bare `hwf` prints help and exits nonzero. `workflow import`, `skills`, `scratch`, `response check`, `help`, and `--version` never call herdr, so an agent inside a turn can call them. `init` without `--global` also never calls herdr. The other commands call herdr, or run `herdr plugin config-dir` to find the global config when `HERDR_PLUGIN_CONFIG_DIR` is not set.

`hwf response check` is the offline oracle behind [`expect:`](/reference#expect). A match exits 0 and prints the token. A mismatch exits nonzero and names the expected tokens. A missing or empty file exits nonzero and names the path. The command never writes to the file.

A run with no terminal shows a herdr notification with the title `herdr-workflows` when it ends. Success shows `<workflow> succeeded in 12s` with the `done` sound. Every other status shows `<workflow> failed after 12s - <run id>` with the `none` sound. A run in a terminal prints its outcome instead.

## Retry a run

A retry starts a new run of the same workflow with the recorded inputs of an earlier run. The new run records the ID of the earlier run. Retry a run that failed, was interrupted, or is stale. A running run cannot be retried.

- `hwf retry <run-id>` runs every step again.
- `hwf retry <run-id> --from-failed` starts at the first top-level step that did not succeed, skip, or launch. The steps before it do not run again. Their recorded results fill `{{steps.*}}`, and run detail marks them `reused`.

A run records its inputs, its dynamic choice options, and the result of each top-level step that has an `id:`. This data stays in the private history database, and the picker and the console never show it. Each result obeys the 8 MiB capture cap. Retention removes the data with the run.

Rules for `--from-failed`:

- The unit is one top-level step. A failed `workflow:` step runs its child again from the first child step.
- You can edit the failed step and the steps after it. If a step before it changed, the retry stops and names that step. Use `hwf retry <run-id>` instead.
- A reused `skipped` step stays skipped. The retry does not examine its `when:` again. Steps from the failed step on examine `when:` as usual.
- A reused `launched` step does not start its background action again.
- If a later step reads `{{steps.<id>.pane_id}}` from a reused step, the retry first asks herdr for that pane. If the pane is gone, the retry stops and names the step.
- `{{context.*}}` comes from the new invocation. `on_failure:` belongs to the new run and runs again if the retry fails.

Run `hwf retry` from the checkout of the earlier run. The retry drops a recorded input that the workflow no longer declares. A new input with no default stops the retry.

## Share a workflow

Press `Ctrl+P`, then `s`, in the picker. The clipboard gets one command:

```bash
hwf workflow import "<bundle>"
```

The bundle holds the selected workflow and every `workflow:` child it reaches. A missing child or a cycle fails the export. [Bundles](/reference#trust-and-sharing) gives the format.

## Import a workflow

Paste the command into a terminal. The CLI shows every YAML body and every sensitivity warning first, then prompts for one destination, `repo` or `global`. Nothing runs during the preview. If a name exists in that scope, the CLI writes nothing and names the conflicts. Rerun with `--force` to replace them. Without a terminal, pass both `--yes` and `--to`.

## Next

- [Examples](/examples) for workflows to import now
- [Reference](/reference) for every field, limit, and rule
