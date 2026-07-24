## ADDED Requirements

### Requirement: Single Rust binary
The plugin SHALL ship as one self-contained Rust binary at `bin/herdr-workflows` providing the `run`, `picker`, `web`, `init`, and `launch` entry modes with the same flags and exit codes as the TypeScript implementation. Neither building nor running the plugin SHALL require Bun, Node, OpenTUI, or any JavaScript runtime.

#### Scenario: Manifest builds with cargo
- **WHEN** the plugin is built from `herdr-plugin.toml`
- **THEN** the build steps invoke `cargo build --release` and produce `bin/herdr-workflows` without invoking `bun`

#### Scenario: No JS runtime at execution
- **WHEN** any of `run`, `picker`, `web`, `init`, or `launch` executes
- **THEN** no Bun or Node process is spawned and no `OPENTUI_LIBC`/`OTUI_ASSET_ROOT` environment is consulted

### Requirement: herdr protocol parity
The Rust adapter SHALL speak the identical herdr integration contract: newline-delimited JSON-RPC over the unix socket at `HERDR_SOCKET_PATH` (`layout.apply`, `plugin.pane.open`, `tab.close` with unchanged param and result shapes) and the same `herdr` CLI subprocess invocations (`pane read`, `agent get`, `pane wait-output`, `pane report-metadata`, `notification show`).

#### Scenario: Socket call shape unchanged
- **WHEN** the plugin performs a socket RPC
- **THEN** it writes exactly one `\n`-terminated JSON request line and reads exactly one `\n`-terminated response line, applying the same 10s timeout

#### Scenario: ui_busy handled
- **WHEN** `plugin.pane.open` returns error code `ui_busy`
- **THEN** the plugin shows a notification instead of failing, matching current behavior

### Requirement: Environment contract parity
The plugin SHALL honor the same environment variables as the TypeScript implementation, including `HERDR_SOCKET_PATH`, `HERDR_PLUGIN_CONTEXT_JSON`, `HERDR_WORKFLOWS_REPO_ROOT`, `HERDR_PLUGIN_STATE_DIR`, and SHALL export `HWF_INPUT_<name>` variables to `shell` step processes.

#### Scenario: Shell step env export
- **WHEN** a `shell` step runs with workflow input `branch` set to `feat/x`
- **THEN** the shell process environment contains `HWF_INPUT_branch=feat/x`

### Requirement: Positioned error parity
Workflow and config load failures SHALL produce positioned error messages in the exact `file, step N, key: message` format the TypeScript loader produces for the same input.

#### Scenario: Identical message for identical invalid YAML
- **WHEN** the same invalid workflow YAML is loaded by the Rust binary and was previously loaded by the TypeScript loader
- **THEN** the error message text and position are identical

### Requirement: Schema artifact parity
`docs/workflow.schema.json` SHALL be generated from the Rust type definitions (via `schemars`) and SHALL describe the same workflow and config surface as the Zod-generated schema it replaces.

#### Scenario: Schema snapshot equivalence
- **WHEN** the schema is regenerated from Rust types
- **THEN** every workflow/config field accepted by the previous schema is accepted and every rejected field is rejected

### Requirement: No async runtime
The binary SHALL NOT embed an async runtime (e.g. tokio). The picker SHALL use a blocking event loop, the web server SHALL be single-threaded, and workflow execution SHALL remain sequential.

#### Scenario: Dependency audit
- **WHEN** the crate's dependency tree is inspected
- **THEN** no async runtime crate appears in it
