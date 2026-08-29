# Run and manage

Use the picker to launch workflows and open the console. Use the CLI to script runs, import bundles, and validate YAML.

Runs happen in the picker or `hwf run`, because a run needs real herdr panes. Inspect runs and workflow lists in the full-screen console.

## The picker

Press `prefix+k`.

The overlay has three tabs, workflows, runs, and profiles. `Tab` cycles the three in that order and back to workflows. `Shift+Tab` cycles the other way. Neither key quits the overlay. A tab bar centers the three labels above the body and marks the active one with reverse video. The pane title stays static.

The workflows footer is `enter run | ctrl+p actions | esc`. The runs footer is `ctrl+g <scope> | enter detail | esc quit`. The profiles footer is `enter open | ctrl+p actions | esc`. The filter placeholders are `filter workflows...`, `filter runs...`, and `filter profiles...`. Filter rows use flush-left ASCII without a `/ ` prefix or indent.

The overlay stays compact. Switching tabs does not close and reopen the popup.

Workflow titles and the description keep the terminal's own foreground, because a fixed palette slot can be unreadable on your theme. Secondary text such as the location column, the footer hints, and the rule is faint, which derives from that same foreground. `invalid` and the sensitivity `!` marker use warn. The selected row uses reverse video. Pointer hover uses underline, not reverse. Pointer gestures also have keyboard keys.

One line per workflow. The list fills the popup rows above a floor of six. Each line shows the title on the left, a warning marker in the middle when the workflow does something sensitive, and `repo`, `global`, or `invalid` on the right. Type to filter, which matches both the displayed title and the file name. The counter on the right of the footer tells you where you are in the filtered list.

### Runs browser

Runs defaults to the exact current checkout root. `Ctrl+G` toggles temporary All scope across retained checkouts. Printable `g` still types into the filter. Each row shows textual status, workflow identity, progress, and elapsed time.

Enter opens one scrollable detail view for the selected run. After the final input, a launch shows `STARTING` until the child claims its run, then the popup closes and the run continues in the background. A launch that herdr rejects, or that cannot record history, keeps the popup open with the reason, because it has no runs-tab entry. A child that ends before it claims a run keeps the popup open with the failure text, because no run record and no notification can report it. Escape returns to the Runs list. An active child continues to run.

A non-terminal run is `RUNNING` while its heartbeat is fresher than fifteen seconds, and `STALE` afterward. Stale is not failure. Detail may show a bounded failure explanation. List rows and search never include that text. Search matches safe step labels from recorded outcomes. History reads only the private plugin-state database.

When you select a workflow, the picker shows its description below the list. It also shows the named sensitivity flags before the run starts. Thus you know what a workflow touches while you can still change your mind.

A workflow that fails to load still appears, marked `invalid`. Select it to read the load error.

While the picker asks for inputs, each question shows its name and description in focus, above the options. One faint line below the options carries your progress, how to answer, the answers you have given, and the back hint. A sensitive workflow adds a short faint line that names what it touches. The answers you have given stay on screen. Press Escape to step back to the previous question with your earlier answer intact, or return to the list from the first one. If you change an earlier answer, the picker drops the later ones, because they might no longer apply.

With no workflows at all, the picker still opens and points you to the actions palette.

### Profiles browser

The profiles tab lists every profile resolved across the configuration layers. Each row shows the profile name and a source column, `global`, `repo`, or `local`, for the layer that effectively defines it. Type to filter by name. The placeholder is `filter profiles...`. Select a profile to read its kind and a short args summary below the list. With no profiles, the tab shows a friendly message that points to `Ctrl+P` then `n`.

`Enter` opens the defining `config.yaml` of the selected profile in `$EDITOR` through the same placement chooser as workflow edit. When the editor closes, the picker validates the configuration with the loader.

Press `Ctrl+P` in the profiles tab for its actions.

| Key | Action                                                                                              |
| --- | --------------------------------------------------------------------------------------------------- |
| `n` | Create a profile: enter a name, choose `global`, `repo`, or `local`, then open the file in `$EDITOR` |
| `o` | Open the selected profile's defining `config.yaml` in `$EDITOR`                                      |

A new profile writes a minimal skeleton into the chosen layer's `config.yaml`. The picker creates the file when it is absent and adds the profile under the existing `profiles:` map without dropping comments or other entries. A duplicate name in that layer is rejected. Edit or delete a profile by hand in the opened `config.yaml`.

### Actions palette

In list mode, press `Ctrl+P`. A single letter fires the action, with no Enter. Escape closes the palette and keeps the picker open.

| Key | Action                                                                                   |
| --- | ---------------------------------------------------------------------------------------- |
| `n` | Create a new workflow, after a chooser for an agent handoff or a template                 |
| `i` | Show status that names `hwf workflow import`                                             |
| `o` | Open the examples page in your browser                                                   |
| `c` | Open the console after a placement chooser |
| `e` | Edit the selected workflow in `$EDITOR`, then validate with the loader                     |
| `s` | Copy the selected workflow's import command and show a herdr notification                |
| `d` | Delete the selected workflow, after a `y` or `n` confirmation                            |

`e`, `s`, and `d` need a selected valid workflow. `n`, `i`, `o`, and `c` do not. The picker stays open for every palette action. `c` opens the console, and the overlay dismisses only after the console pane opens.

Plain `k` still types into the filter.

#### New workflow

`n` opens a chooser with two options.

Choose **build with an agent** to hand the work to a herdr agent pane. The picker offers an agent-pane chooser. With one pane open, it types the handoff at once. With more than one, select the pane and press `Enter`. Each chooser row shows the tab number, a status glyph, the pane title, and `(you)` on the pane you started from. The status glyphs are `*` busy, `-` idle, `!` blocked, and `?` unknown, and the footer repeats the first three. The title comes from a renamed agent, then the pane's terminal title, then the pane ID. Herdr loses terminal titles on a cold restart, so a pane can show its ID again. The picker types a prompt that asks the agent to follow the `herdr-workflow-create` skill, to grill you about the goal, steps, and inputs before it writes any YAML, to save the workflow at the repo or global level, and to validate the file with `hwf workflow validate`. The prompt is typed, not submitted, so press `Enter` in the pane to start. The overlay dismisses after the handoff. With no agent pane open, the overlay stays open and shows a plain status line.

Choose **edit a template** to write a pre-filled skeleton yourself. Enter a name, then choose the repo (`.hwf/workflows`) or global level. The picker creates the skeleton and opens the same placement chooser as edit (`popup`, `beside`, `below`, `tab`). `popup` opens the editor in the large popup.

## The console

Reach the console by pop-out from the overlay. Open the actions palette with `Ctrl+P` and press `c`. A placement chooser offers `beside`, `below`, and `new tab`. `beside` is the default. The chooser shows `new tab` for the placement value `tab`. The session default is the last successful open, and it starts at `beside`.

If the console pane cannot open, because you are not inside herdr or there is no pane host, the overlay stays open and shows a plain status line.

After a successful pop-out from a selected workflow, the console opens on that workflow's diagram. Press `Escape` to return to the console catalog. With nothing valid selected, the console opens on the workflows list.

The console is a full-screen Charm TUI. It uses the same catalog chrome as the overlay. Workflow rows show the title, the sensitivity `!`, and the `repo`, `global`, or `invalid` location. The filter placeholders are `filter workflows...` and `filter runs...`. `Tab` cycles the workflows list and the runs list, two labels. `Enter` on a workflow opens a read-only diagram of its steps, `when:` edges, and pane targets from the parsed definition. On the diagram, `v` selects step nodes and `s` sends an annotation bundle (selected step YAML plus your instruction) into an agent pane input, but does not submit it. `Enter` on a run opens debug tabs: `1` log, `2` transcript, `3` yaml-at-run. Press `y` to copy `hwf run <name>` for a retry, without a submit. `Escape` backs out. Quitting restores the terminal.

The workflows footer is `tab | enter diagram | esc`. The runs footer is `tab | enter detail | esc`.

`hwf console` runs the console TUI. `hwf console --placement <tab|beside|below>` opens it in a pane, and falls back to the in-process TUI when no pane host is available and a terminal is present.

## The CLI

| Command                         | What it does                                                             |
| ------------------------------- | ------------------------------------------------------------------------ |
| `hwf run <name>`                | Runs a workflow. `--input name=value`, repeatable                        |
| `hwf workflow inspect <name>`   | Prints what a workflow will ask for. `--resolve` runs the lookups        |
| `hwf workflow validate <file>`  | Validates a YAML file through the loader. Prints JSON, exits 0 or 1      |
| `hwf workflow import "<...>"`   | Imports a shared bundle. `--to repo\|global`, `--yes`, `--force`         |
| `hwf init`                      | Writes config. `--global`, `--force`                                     |
| `hwf launch`                    | Opens the workflow picker popup                                          |
| `hwf picker`                    | Runs the picker in the current terminal                                  |
| `hwf console`                   | Runs the console TUI, or opens it with `--placement`                     |
| `hwf update`                    | Installs the latest published release                                    |
| `hwf skills list`               | Lists the bundled agent skills                                           |
| `hwf skills show <name>`        | Prints one bundled skill with its reference files                        |
| `hwf scratch get <key>`         | Prints a scratch value from the global history database                  |
| `hwf scratch set <key> <value>` | Writes a scratch value                                                   |
| `hwf scratch list`              | Lists scratch keys                                                       |
| `hwf scratch delete <key>`      | Deletes a scratch key                                                    |
| `hwf response check <file>`     | Checks a response file's verdict. `--one-of TOKEN,TOKEN`                 |
| `hwf help [command]`            | Shows help for one command or all of them                                |
| `hwf --version`                 | Prints the installed plugin version                                      |

Bare `hwf` with no subcommand prints help and exits nonzero.

A run that has no interactive terminal shows a herdr notification when it ends. A picker launch and a `nohup hwf run ... &` are both detached. The title is `herdr-workflows`. A run that succeeded shows `<workflow> succeeded in 12s` with the `done` sound. Every other terminal status shows `<workflow> failed after 12s - <run id>` with the `none` sound. A run in a terminal stays silent, because it already prints its outcome.

`hwf` and `herdr-workflows` are the same command under two names.

### `hwf response check`

```bash
hwf response check /path/to/response.txt --one-of APPROVE,REJECT
```

The offline verdict oracle behind [`expect:`](/reference#expect). It reads the final non-empty line of the file, trims it, and matches it against the comma-separated tokens, which follow the same rules as `expect.one_of`. A match exits 0 and prints the token. A mismatch exits nonzero and names both the line that failed and the expected tokens. A missing or empty file exits nonzero and names the path. The command never writes to the file.

Only `hwf launch`, `hwf run`, `hwf picker`, and `hwf console` run the version and protocol preflight. `skills`, `workflow validate`, `response`, and `scratch` never contact herdr at all. Thus an agent inside a turn can call `response check`, `workflow validate`, or `scratch` and get an answer immediately. That is what the runner's appended instruction asks it to do: rerun the check against its own response file until it exits 0.

### Scratch

The scratch store holds keys and values in the global history database. Workflows do not read it through templates. A step runs `hwf scratch get` or `hwf scratch set` and consumes stdout. How to write that step: [Use the scratch store](/guide#use-the-scratch-store). Limits: [Reference](/reference#scratch).

## Share a workflow

A share produces one command:

```bash
hwf workflow import "<bundle>"
```

Get it from the picker palette with `Ctrl+P` then `s`.

The bundle is a gzip-compressed, base64-encoded list of `{name, yaml}` entries. It holds the workflow you picked plus every `workflow:` child it reaches, found the same way a run finds them: repo first, then global. A missing child or a cycle fails the export. The export does not carry an incomplete bundle. Export carries each exact YAML body, including a `$schema` pointer when one exists, and no local paths, config, or scope record. Import pins written files to its own contract.

## Import a workflow

Paste the command into a terminal. The CLI accepts only the bundle or the exact generated import-command shape.

The CLI shows you every YAML body and every sensitivity warning first, then asks for one destination, `repo` or `global`, for the whole bundle. Nothing runs during a preview: no steps, no child lookups, no option-listing commands.

If a name already exists in that scope, the CLI writes nothing until you confirm. The CLI reports the conflicts and asks you to rerun with `--force`. The scope becomes wholly the bundle or stays wholly as it was.

Without a terminal, the CLI needs both `--yes` and `--to`.

The old single-workflow share payload no longer loads. Re-export from the current version instead.

## Next

- [Examples](/examples) — workflows to import now
- [Reference](/reference) — every field, limit, and rule
