# Run and manage

Three places to work: the picker for running, the CLI for scripting, and the browser workbench for editing.

Runs happen in the picker or `hwf run`, because a run needs real herdr panes. The workbench never runs anything.

## The picker

Press `prefix+k`.

One line per workflow, six at a time. Each line shows the title on the left, a warning marker in the middle when the workflow does something sensitive, and `repo`, `global`, or `invalid` on the right. Type to filter, which matches both the title you see and the file name. The counter on the right of the footer tells you where you are in the filtered list.

Selecting a workflow shows its description below the list, and its named sensitivity flags before the run starts, so you see what a workflow touches while you can still change your mind.

A workflow that fails to load still appears, marked `invalid`. Select it to read the load error.

While the picker asks for inputs, the answers you've given stay on screen. Press Escape to step back to the previous question with your earlier answer intact, or back out to the list from the first one. Changing an earlier answer drops the later ones, because they might no longer apply.

With no workflows at all, the picker still opens and points you at the actions palette.

### Actions palette

In list mode, press `Ctrl+K`. A single letter fires the action, with no Enter. Escape closes the palette and keeps the picker open.

| Key | Action                                                                    |
| --- | ------------------------------------------------------------------------- |
| `n` | Create a workflow in the workbench                                        |
| `i` | Open the workbench import view                                            |
| `e` | Open the examples page in your browser                                    |
| `o` | Edit the selected workflow in the workbench                               |
| `s` | Copy the selected workflow's import command and show a herdr notification |
| `d` | Delete the selected workflow, after a `y` or `n` confirmation             |

`o`, `s`, and `d` need a selected workflow. `n`, `i`, and `e` don't. The picker closes after handing off to the workbench for `n`, `i`, and `o`, and stays open for `s` and `d`.

Plain `k` still types into the filter.

## The CLI

| Command                       | What it does                                                      |
| ----------------------------- | ----------------------------------------------------------------- |
| `hwf run <name>`              | Runs a workflow. `--input name=value`, repeatable                 |
| `hwf workflow inspect <name>` | Prints what a workflow will ask for. `--resolve` runs the lookups |
| `hwf workflow import "<...>"` | Imports a shared bundle. `--to repo\|global`, `--yes`, `--force`  |
| `hwf init`                    | Writes config. `--global`, `--force`                              |
| `hwf web [route]`             | Starts the workbench. `--port`, `--no-open`                       |
| `hwf update`                  | Installs the latest published release                             |
| `hwf help [command]`          | Shows help for one command or all of them                         |
| `hwf --version`               | Prints the installed plugin version                               |

Bare `hwf` in a terminal is the same as `hwf web`. Without a terminal it prints help and exits nonzero, so a script can't accidentally start a server.

`hwf` and `herdr-workflows` are the same command under two names.

## The workbench

```bash
hwf web            # opens your browser
hwf web --no-open  # prints the URL instead
```

Three tabs:

- **Workflows** lists your repo and global workflows and opens one in the editor.
- **Config** edits `.hwf/config.yaml` or your global config, and checks the YAML before saving.
- **Runs** shows recent runs from the run log: which workflow, which step, and what failed.

### Editing

The editor has two modes over the same file. **YAML mode** is a text editor with highlighting. **Canvas mode** draws your steps as connected nodes you can add, reorder, and fill in through forms.

The node forms come from the same schema the loader uses, so a field offers exactly the values the format accepts: a closed list where the format has a fixed set, a number with real bounds, rows for environment variables, lines for command arguments. `herdr:` steps pick from the generated method list, and a method the plugin refuses shows up as unavailable with the reason. A key the schema doesn't know is kept as-is and flagged as carried over from your YAML.

Validation runs through this plugin's own loader, and each message lands on the field it's about.

Undo and redo cover both modes. Save appears only when something differs from the file on disk, and disappears again if you undo back to it.

Saving is careful about your files:

- Changing the scope selector doesn't move anything until you save. Then the move happens as one operation: claim the destination, remove the original.
- A save that would overwrite a file the editor didn't load is rejected, and names the conflict. Nothing is written.
- If the file changed underneath you — another tab, an import, a checkout — the save is rejected as stale and the other writer's content stays.

Saved files get a `# yaml-language-server: $schema=` line pointing at the contract this build implements, so your editor can complete and check the file. Text already pinned to that contract is written back byte for byte.

The canvas also has zoom, fit, expand-to-viewport, and a shortcuts panel you open when you want it. The header has a theme control that follows your system, or stays dark or light.

### Reusing one workbench

Picker actions and `hwf web` reuse one live workbench per repository, as long as its recorded address still answers an authenticated check. A stale record is replaced. Another repository's workbench is never reused.

A workbench also stops itself when the code it was built from changes, so an upgrade or a development edit can't leave a server serving the previous build.

## Share a workflow

Sharing produces one command:

```bash
hwf workflow import "<bundle>"
```

Get it from the picker palette with `Ctrl+K` then `s`, or from **Share** in the editor's overflow menu.

The bundle is a gzip-compressed, base64-encoded list of `{name, yaml}` entries. It holds the workflow you picked plus every `workflow:` child it reaches, found the same way a run finds them: repo first, then global. A missing child or a cycle fails the export rather than shipping something incomplete. The bundle carries names and YAML only — no version, no paths, no config, and no record of where the files came from.

## Import a workflow

Paste the command into a terminal, or into the workbench **Import** view. The workbench also takes a single raw workflow YAML document if you give it a name. The CLI takes the bundle only.

Both surfaces show you every YAML body and every sensitivity warning first, then ask for one destination, `repo` or `global`, for the whole bundle. Nothing runs during a preview: no steps, no child lookups, no option-listing commands.

If a name already exists in that scope, nothing is written until you say so. The workbench asks you to confirm replacing all of them. The CLI reports the conflicts and asks you to rerun with `--force`. Either way the scope ends up wholly as the bundle or wholly as it was.

Without a terminal, the CLI needs both `--yes` and `--to`.

The old single-workflow share payload no longer loads. Re-export from the current version instead.

## Next

- [Examples](/examples) — workflows to import now
- [Reference](/reference) — every field, limit, and rule
