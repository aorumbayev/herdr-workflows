# picker-editor-actions Specification

## Purpose
Picker shortcuts for editing workflows in `$EDITOR`, importing via the CLI, sharing, and deleting.
## Requirements
### Requirement: Picker reports published plugin updates without blocking
Picker startup MUST check for a newer published GitHub Release without delaying workflow loading, mounting, filtering, or selection. Draft releases, invalid tags, older versions, and failed or timed-out checks MUST NOT display an update or fail the picker. When a newer valid version is found, the list view MUST show a width-bounded printable-ASCII indicator containing `run hwf update` in the filter row. The indicator MUST NOT consume a workflow row, change the static Herdr pane title, displace the fixed footer, or appear in input and run modes.

#### Scenario: Newer release appears after mount
- **WHEN** the picker has mounted and its background check finds a newer published plugin version
- **THEN** the list view adds an ASCII `run hwf update` indicator without shifting the workflow viewport or footer

#### Scenario: Update service is unavailable
- **WHEN** the release check fails or times out
- **THEN** the picker remains fully interactive and displays no update error or indicator

#### Scenario: Draft is not advertised
- **WHEN** GitHub contains a newer draft release
- **THEN** the picker does not advertise that version

### Requirement: List mode opens an actions palette with Ctrl+K
In list mode, `Ctrl+K` MUST open an actions palette and MUST NOT insert into the workflow filter. Printable `k` without a control modifier MUST remain filter text. While the palette is open, a single matching letter MUST fire the action immediately without requiring Enter. Escape MUST close the palette and return to the list without dismissing the picker. The list footer MUST identify `ctrl+k` rather than per-action Ctrl chords. The palette MUST draw its rows with the shared list row chrome, MUST mute an action the current selection cannot fire rather than hide it, and MUST close its body with the separator and the muted footer the other picker screens use.

#### Scenario: Open palette
- **WHEN** the user presses `Ctrl+K` in list mode
- **THEN** the actions palette opens and the filter does not receive a `k`

#### Scenario: Printable k filters
- **WHEN** the user types `k` without a control modifier in list mode
- **THEN** the character is added to the workflow filter

#### Scenario: Escape closes palette
- **WHEN** the actions palette is open and the user presses Escape
- **THEN** the picker returns to list mode and stays open

#### Scenario: Palette uses the shared chrome
- **WHEN** the actions palette is open with no workflow selected
- **THEN** its rows carry the list row indent, the actions that need a selection are muted, and the body ends with the separator and the muted palette footer

### Requirement: Palette actions for authorship and discovery
The actions palette MUST offer: `n` create a new repo workflow (prompt for a `NameRE` name, write a stub under `.hwf/workflows/<name>.yaml` with the pinned schema pointer, open it in `$EDITOR` or `$VISUAL`, then validate with the loader), `i` show status directing the user to `hwf workflow import "..."`, and `e` open the published examples URL in the platform browser. These three MUST be available without a selected workflow, including when the catalog is empty. New and import MUST keep the picker open. Examples MUST attempt the platform browser opener.

#### Scenario: New from empty catalog
- **WHEN** the catalog is empty and the user presses `Ctrl+K` then `n`, enters a valid name, and the editor exits
- **THEN** the picker creates the stub, validates with the loader, shows status, and stays open

#### Scenario: Import from empty catalog
- **WHEN** the catalog is empty and the user presses `Ctrl+K` then `i`
- **THEN** the picker shows status naming `hwf workflow import` and stays open

#### Scenario: Browse examples
- **WHEN** the user presses `Ctrl+K` then `e`
- **THEN** the examples documentation URL is opened with a host platform browser opener

### Requirement: Palette open edits the selected workflow
`o` in the actions palette MUST open a placement chooser for the selected valid workflow: `popup` (the default), `beside`, `below`, or `tab`. `popup` MUST respawn the picker popup at the console size, open the file there in `$EDITOR` or `$VISUAL`, wait for the editor to exit, validate with the loader, and respawn the picker at the compact size. `beside`, `below`, and `tab` MUST open the editor in a managed plugin pane at that placement, validate on exit, and close that pane without reopening the picker. When there is no selected valid workflow, `o` MUST NOT launch an editor action.

#### Scenario: Open repo workflow
- **WHEN** repo workflow `deploy` is selected and the user presses `Ctrl+K` then `o` then confirms `popup`
- **THEN** the picker respawns at the console size, opens that file in the editor inside the popup, validates on exit, and respawns compact

#### Scenario: Open in a new tab
- **WHEN** the user confirms `tab` for the selected workflow
- **THEN** the editor opens in a managed pane in a new tab, and the picker closes without reopening

#### Scenario: Open without selection
- **WHEN** the filtered list has no selected workflow and the user presses `Ctrl+K` then `o`
- **THEN** the picker does not launch an editor action

### Requirement: Palette share copies the import command and notifies
`s` in the actions palette MUST export the selected valid workflow's connected bundle, copy `hwf workflow import "<bundle>"` to the system clipboard, keep the picker open, close the palette back to the list, and show a herdr `notification.show` whose text states that workflow `{name}` has been copied to the clipboard. When there is no selected valid workflow, or export/clipboard fails, it MUST NOT claim success and MUST surface failure via notification or picker status while keeping the picker open.

#### Scenario: Share copies command
- **WHEN** workflow `deploy` is selected and the user presses `Ctrl+K` then `s` and export and clipboard succeed
- **THEN** the clipboard holds the import command for that workflow's connected bundle, a herdr notification reports that Workflow deploy has been copied to the clipboard, and the picker remains open on the list

#### Scenario: Share stays in picker
- **WHEN** share succeeds from the palette
- **THEN** the picker stays open on the list

### Requirement: Palette delete confirms then removes the workflow file
`d` in the actions palette MUST enter a confirmation step naming the selected workflow and its source. `y` MUST delete that workflow's file on disk, refresh the picker list, and return to list or empty state. `n` or Escape MUST cancel and return without deleting. When there is no selected valid workflow, `d` MUST NOT delete.

#### Scenario: Confirmed delete
- **WHEN** repo workflow `deploy` is selected and the user presses `Ctrl+K` then `d` then `y`
- **THEN** the repo workflow file is removed, the list refreshes without `deploy`, and the picker stays open

#### Scenario: Cancel delete
- **WHEN** the user presses `Ctrl+K` then `d` then `n`
- **THEN** no workflow file is removed and the picker remains open

### Requirement: In-popup editor stays on the popup tty
Palette `o` MUST open the selected valid workflow in `$EDITOR` or `$VISUAL` through `tea.ExecProcess` on the picker popup tty, wait for the editor to exit, validate with the loader, show status, and keep the picker open. When neither `EDITOR` nor `VISUAL` is set, the picker MUST fail with an error that names those variables and MUST NOT fall back to `vi`. The large percent popup is the editor surface. The picker MUST NOT hand the file to a second pane to work around popup size.

#### Scenario: Open uses ExecProcess
- **WHEN** repo workflow `deploy` is selected and the user presses `Ctrl+K` then `o` with `EDITOR` set
- **THEN** the picker runs that editor on the popup tty, validates on exit, shows status, and stays open

#### Scenario: Missing editor is a hard error
- **WHEN** the user fires palette `o` and neither `EDITOR` nor `VISUAL` is set
- **THEN** the picker shows an error that names `EDITOR` and `VISUAL` and does not launch `vi`

### Requirement: Palette labels are single words and unavailable actions are hidden
The actions palette MUST label each action with a single word: `new`, `import`, `examples`, `console`, `edit`, `share`, and `delete`. The bare-letter keys MUST stay `n i e c o s d`. `new`, `import`, `examples`, and `console` MUST always be present. `edit`, `share`, and `delete` MUST be hidden when no valid workflow is selected and MUST appear when one is. A hidden action MUST NOT be reachable by its letter.

#### Scenario: Empty catalog palette
- **WHEN** the catalog has no valid workflow and the user opens the actions palette
- **THEN** only `new`, `import`, `examples`, and `console` are listed

#### Scenario: Selected workflow palette
- **WHEN** a valid workflow is selected and the user opens the actions palette
- **THEN** all seven single-word labels are listed

