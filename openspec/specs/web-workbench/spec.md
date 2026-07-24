# web-workbench Specification

## Purpose

Browser-based workbench (`hwf web`) for browsing, validating, and editing workflows and config across repo and global scopes. Read/edit only — never executes workflows.

## Requirements

### Requirement: hwf web command
The plugin SHALL provide `hwf web [--port <n>] [--no-open]` that starts an HTTP server bound to `127.0.0.1` serving a single-page workbench, resolves the repo via `resolveRepoRoot(cwd)`, and runs in the foreground until interrupted. By default it opens the system browser at the served URL; `--no-open` suppresses that.

#### Scenario: Server binds localhost only
- **WHEN** `hwf web` starts
- **THEN** the listening socket is bound to `127.0.0.1` and not to any external interface

#### Scenario: No-open flag
- **WHEN** `hwf web --no-open` starts
- **THEN** the server runs and prints its URL but does not launch a browser

#### Scenario: Default port busy
- **WHEN** `hwf web` starts with no `--port` and port `7317` is already in use
- **THEN** the server increments the port until one binds and prints the chosen URL

### Requirement: Token and origin gating
Every HTTP route (read and write) SHALL require a valid per-launch token supplied as the `x-hwf-token` header and SHALL reject any request whose `Origin` or `Host` is not the bound localhost address.

#### Scenario: Missing token rejected
- **WHEN** an API request arrives without the correct `x-hwf-token`
- **THEN** the server responds 403 and performs no file read or write

#### Scenario: Foreign origin rejected
- **WHEN** a request carries an `Origin` header that is not the served localhost address
- **THEN** the server responds 403

### Requirement: Browse repo and global workflows
The server SHALL expose the merged workflow list from `collectWorkflowEntries` (repo + global, repo shadowing global by name), each entry marked with its `source` and whether it currently validates, plus the configured agent names.

#### Scenario: Repo shadows global in listing
- **WHEN** a workflow name exists in both `.hwf/workflows` and `~/.hwf/workflows`
- **THEN** the listing returns a single entry for that name with `source: repo`

### Requirement: Live validation over unsaved text
The server SHALL validate an unsaved YAML buffer via the same load path the file loader uses, returning either success or the positioned error (file/step/key/message) the CLI would produce.

#### Scenario: Invalid buffer returns positioned error
- **WHEN** a client POSTs YAML with a placeholder in a `shell:` command to the validate route
- **THEN** the response reports failure with the same positioned message `hwf run` would emit

#### Scenario: Validation does not write
- **WHEN** a client POSTs a buffer to the validate route
- **THEN** no workflow file is created or modified

### Requirement: Save workflows to a scope
The server SHALL write a workflow to the chosen scope (repo `.hwf/workflows` or global `~/.hwf/workflows`) only after it passes validation, and SHALL reject a save whose buffer fails validation.

#### Scenario: Invalid save rejected
- **WHEN** a client saves a buffer that fails validation
- **THEN** the file is not written and the response reports the error

### Requirement: No run from browser
The web UI SHALL NOT execute workflows. It SHALL surface the equivalent `hwf run <name>` invocation for the user to run in a terminal.

#### Scenario: No run endpoint
- **WHEN** the web API surface is enumerated
- **THEN** it contains no route that executes a workflow into herdr panes

### Requirement: Edit config
The server SHALL read and write `config.yaml` for the chosen scope, writing only after the content passes the same `loadConfig` validation the CLI uses, and rejecting invalid config.

#### Scenario: Invalid config rejected
- **WHEN** a client saves config that fails `loadConfig` validation
- **THEN** the file is not written and the response reports the error

### Requirement: Share via promote across scope
The server SHALL copy a workflow between repo and global scope, refusing to overwrite an existing target of the same name unless the caller explicitly forces it.

#### Scenario: Promote refuses clobber
- **WHEN** promoting a workflow to a scope where a workflow of that name already exists, without force
- **THEN** the server responds 409 and does not overwrite the target

#### Scenario: Forced promote overwrites
- **WHEN** the same promote is retried with force set
- **THEN** the target is overwritten
