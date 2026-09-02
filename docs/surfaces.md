# Run and manage

The picker launches workflows and opens the console. Use the CLI to script runs, import bundles, and validate YAML. A run needs real herdr panes.

## The picker

Press `prefix+k`. The overlay has three tabs: workflows, runs, and profiles. `Tab` and `Shift+Tab` cycle them. The footer of each tab lists its keys. Type to filter by title or file name. Text fields accept a clipboard paste. Newlines become spaces, and the picker refuses a paste of more than 16 KiB.

Each workflow row shows the title, a `!` marker when the workflow does something sensitive, and `repo`, `global`, or `invalid`. When you select a workflow, its description and its sensitivity flags show below the list. Select an `invalid` workflow to read the load error. With no workflows, the picker points you to the actions palette.

While the picker prompts for inputs, each question shows its name and description above the options. A faint line shows your progress and earlier answers. Press `Escape` to return to the previous question. If you change an earlier answer, the picker drops the later ones.

### Runs

The runs tab defaults to the current checkout root. `Ctrl+G` toggles an All scope across retained checkouts. Each row shows the status, the workflow, the progress, and the elapsed time. `Enter` opens a detail view. `Escape` returns to the list, and an active run continues.

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

`Tab` cycles the workflows list and the runs list. `Enter` on a workflow opens a read-only diagram of its steps, its `when:` edges, and its pane targets. On the diagram, `v` selects step nodes and `s` sends the selected YAML plus your instruction into an agent pane input, without a submit. `Enter` on a run opens debug tabs: `1` log, `2` transcript, `3` yaml-at-run. `y` copies `hwf run <name>` for a retry, without a submit. `Escape` returns.

`hwf console` runs the console in the current terminal. `hwf console --placement <tab|beside|below>` opens it in a pane, or in the terminal when no pane host is available.

## The CLI

| Command                                | What it does                                                          |
| -------------------------------------- | --------------------------------------------------------------------- |
| `hwf run <name>`                       | Runs a workflow. `--input name=value`, repeatable                     |
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

`hwf` and `herdr-workflows` are the same command. Bare `hwf` prints help and exits nonzero. Only `launch`, `run`, `picker`, and `console` contact herdr. The other commands never do, so an agent inside a turn can call them.

`hwf response check` is the offline oracle behind [`expect:`](/reference#expect). A match exits 0 and prints the token. A mismatch exits nonzero and names the expected tokens. A missing or empty file exits nonzero and names the path. The command never writes to the file.

A run with no terminal shows a herdr notification with the title `herdr-workflows` when it ends. Success shows `<workflow> succeeded in 12s` with the `done` sound. Every other status shows `<workflow> failed after 12s - <run id>` with the `none` sound. A run in a terminal prints its outcome instead.

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
