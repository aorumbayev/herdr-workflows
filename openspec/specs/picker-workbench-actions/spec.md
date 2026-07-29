# picker-workbench-actions Specification

## Purpose
Picker shortcuts and secure repository workbench endpoint reuse for editing, sharing, and importing workflows.

## Requirements
### Requirement: Picker exposes workbench actions without consuming filter text
In list mode, the picker MUST provide `Ctrl+E` to edit the selected workflow, `Ctrl+Y` to share the selected workflow, and `Ctrl+O` to open workflow import. These shortcuts MUST NOT insert text into, or remove supported characters from, the focused filter. The list footer MUST identify them.

#### Scenario: Filter retains printable letters
- **WHEN** a user types `e`, `y`, or `o` without a control modifier in list mode
- **THEN** the picker adds the character to the workflow filter rather than invoking a workbench action

#### Scenario: Shortcut hints are visible
- **WHEN** the picker displays its workflow list
- **THEN** its footer identifies run, edit, share, import, and dismiss controls

### Requirement: Selected workflow actions preserve provenance
Edit and share actions MUST target the currently selected valid workflow entry. They MUST include both its `source` and `name`. The picker MUST launch the workbench action only in list mode, and it MUST dismiss after handing off a valid action.

#### Scenario: Edit repo workflow
- **WHEN** a user presses `Ctrl+E` with repo workflow `deploy` selected
- **THEN** the picker opens the workbench editor route for `repo:deploy` and dismisses

#### Scenario: Share shadowing global workflow
- **WHEN** repo and global workflows have the same name and the selected entry has repo provenance
- **THEN** `Ctrl+Y` opens the share route for the repo source

#### Scenario: No selected row
- **WHEN** edit or share is requested while the filtered list has no selected workflow
- **THEN** the picker does not launch a workbench action

### Requirement: Import is available without a workflow selection
The picker MUST open the workbench import route from list mode without requiring a selected workflow.

#### Scenario: Empty list import
- **WHEN** the current filter has no matching workflow and the user presses `Ctrl+O`
- **THEN** the picker opens the repository workbench import route and dismisses

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
