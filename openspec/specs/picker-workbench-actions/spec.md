# picker-workbench-actions Specification

## Purpose
Picker shortcuts and secure repository workbench endpoint reuse for editing, sharing, and importing workflows.

## Requirements
### Requirement: Workbench actions reuse a repository endpoint
Workbench actions for the same canonical repository root MUST reuse a live authenticated workbench endpoint. The picker MUST never reuse a stale, invalid, or repository-mismatched endpoint record, and concurrent endpoint checks MUST never intentionally create duplicate servers.

#### Scenario: Existing workbench
- **WHEN** a picker action finds a reachable authenticated endpoint for the same repository root
- **THEN** it opens the requested route against that endpoint without starting another server

#### Scenario: Stale endpoint
- **WHEN** the recorded endpoint cannot answer an authenticated probe
- **THEN** the action replaces it with a newly started repository workbench

#### Scenario: Different repository
- **WHEN** another repository has a live workbench endpoint
- **THEN** the action does not use that endpoint for the current repository

### Requirement: Endpoint credentials remain private runtime state
The picker MUST store workbench endpoint records as disposable plugin runtime state that no principal other than the current user can read or write. Before writing a bearer token, the plugin MUST verify that the resolved location grants no read or write access to any other principal, and MUST refuse naming that location when it cannot. The same protection MUST cover every file carrying the bearer token, including the endpoint lock file. A record MUST be trusted only after an authenticated probe confirms its canonical repository root.

#### Scenario: Endpoint record written
- **WHEN** a web command starts and publishes a workbench endpoint
- **THEN** the containing state and record do not grant other users access to the bearer token

#### Scenario: Environment-controlled state directory is checked
- **WHEN** the plugin state directory is redirected to a location readable by other unprivileged accounts
- **THEN** the plugin refuses to write the credential there and names the directory

#### Scenario: Lock file carries the same protection
- **WHEN** the endpoint lock file is created with the bearer token
- **THEN** it receives the same access restriction as the endpoint record

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
In list mode, `Ctrl+K` MUST open an actions palette and MUST NOT insert into the workflow filter. Printable `k` without a control modifier MUST remain filter text. While the palette is open, a single matching letter MUST fire the action immediately without requiring Enter. Escape MUST close the palette and return to the list without dismissing the picker. The list footer MUST identify `ctrl+k` rather than per-action Ctrl chords.

#### Scenario: Open palette
- **WHEN** the user presses `Ctrl+K` in list mode
- **THEN** the actions palette opens and the filter does not receive a `k`

#### Scenario: Printable k filters
- **WHEN** the user types `k` without a control modifier in list mode
- **THEN** the character is added to the workflow filter

#### Scenario: Escape closes palette
- **WHEN** the actions palette is open and the user presses Escape
- **THEN** the picker returns to list mode and stays open

### Requirement: Palette actions for authorship and discovery
The actions palette MUST offer: `n` create new workflow (workbench `#new`), `i` open workbench import (`#import`), and `e` open the published examples URL in the platform browser. These three MUST be available without a selected workflow, including when the catalog is empty. New and import MUST reuse the repository workbench endpoint rules. New and import MUST dismiss the picker after a successful handoff. Examples MUST attempt the platform browser opener and MUST NOT require a workbench server.

#### Scenario: New from empty catalog
- **WHEN** the catalog is empty and the user presses `Ctrl+K` then `n`
- **THEN** the picker opens the workbench new-workflow route and dismisses

#### Scenario: Import from empty catalog
- **WHEN** the catalog is empty and the user presses `Ctrl+K` then `i`
- **THEN** the picker opens the repository workbench import route and dismisses

#### Scenario: Browse examples
- **WHEN** the user presses `Ctrl+K` then `e`
- **THEN** the examples documentation URL is opened with a host platform browser opener

### Requirement: Palette open edits the selected workflow
`o` in the actions palette MUST open the workbench editor for the currently selected valid workflow, including both its `source` and `name`, and MUST dismiss the picker after handoff. When there is no selected valid workflow, `o` MUST NOT launch a workbench action.

#### Scenario: Open repo workflow
- **WHEN** repo workflow `deploy` is selected and the user presses `Ctrl+K` then `o`
- **THEN** the picker opens the workbench editor route for `repo:deploy` and dismisses

#### Scenario: Open without selection
- **WHEN** the filtered list has no selected workflow and the user presses `Ctrl+K` then `o`
- **THEN** the picker does not launch a workbench action

### Requirement: Palette share copies the import command and notifies
`s` in the actions palette MUST export the selected valid workflow's connected bundle, copy `hwf workflow import "<bundle>"` to the system clipboard, keep the picker open, close the palette back to the list, and show a herdr `notification.show` whose text states that workflow `{name}` has been copied to the clipboard. It MUST NOT open the workbench share route. When there is no selected valid workflow, or export/clipboard fails, it MUST NOT claim success and MUST surface failure via notification or picker status while keeping the picker open.

#### Scenario: Share copies command
- **WHEN** workflow `deploy` is selected and the user presses `Ctrl+K` then `s` and export and clipboard succeed
- **THEN** the clipboard holds the import command for that workflow's connected bundle, a herdr notification reports that Workflow deploy has been copied to the clipboard, and the picker remains open on the list

#### Scenario: Share does not open workbench
- **WHEN** share succeeds from the palette
- **THEN** no workbench share route is launched

### Requirement: Palette delete confirms then removes the workflow file
`d` in the actions palette MUST enter a confirmation step naming the selected workflow and its source. `y` MUST delete that workflow's file on disk, refresh the picker list, and return to list or empty state without opening the workbench. `n` or Escape MUST cancel and return without deleting. When there is no selected valid workflow, `d` MUST NOT delete.

#### Scenario: Confirmed delete
- **WHEN** repo workflow `deploy` is selected and the user presses `Ctrl+K` then `d` then `y`
- **THEN** the repo workflow file is removed, the list refreshes without `deploy`, and the picker stays open

#### Scenario: Cancel delete
- **WHEN** the user presses `Ctrl+K` then `d` then `n`
- **THEN** no workflow file is removed and the picker remains open
