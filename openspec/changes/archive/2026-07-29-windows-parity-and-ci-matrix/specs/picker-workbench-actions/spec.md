## MODIFIED Requirements

### Requirement: Endpoint credentials remain private runtime state
The picker MUST store workbench endpoint records as disposable plugin runtime state that no other unprivileged local account can read, using user-only permission bits. The plugin MUST verify that the resolved state directory grants no broader access before writing a credential into it, because the state directory location is environment-controlled. The same protection MUST cover every file carrying the bearer token, including the endpoint lock file. A record MUST be trusted only after an authenticated probe confirms its canonical repository root.

#### Scenario: Endpoint record written
- **WHEN** a web command starts and publishes a workbench endpoint
- **THEN** the containing state and record do not grant other users access to the bearer token

#### Scenario: Environment-controlled state directory is checked
- **WHEN** the plugin state directory is redirected to a location readable by other unprivileged accounts
- **THEN** the plugin refuses to write the credential there and names the directory

#### Scenario: Lock file carries the same protection
- **WHEN** the endpoint lock file is created with the bearer token
- **THEN** it receives the same access restriction as the endpoint record

## ADDED Requirements

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
