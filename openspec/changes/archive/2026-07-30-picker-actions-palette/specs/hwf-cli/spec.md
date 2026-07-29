## ADDED Requirements

### Requirement: Picker mounts when the catalog is empty
`hwf picker` / the plugin picker entrypoint MUST mount the picker UI when there are no visible workflows. It MUST NOT exit solely because the catalog is empty.

#### Scenario: Empty catalog picker
- **WHEN** `hwf picker` runs on a TTY in a repository with no visible workflows
- **THEN** the picker UI mounts instead of exiting with a no-workflows error

## MODIFIED Requirements

### Requirement: Init and import consent flags
`init` MUST accept `--force` as overwrite consent without prompting. It MUST also accept `--global`. `workflow import` MUST require a payload argument that is a base64 workflow bundle or the exact generated import-command shape, and MUST accept `--to=repo|global` or `--to <scope>`, `--yes` / `-y`, and `--force`. The `--to` option MUST use a Commander `Option` choice for `repo` or `global`. Non-TTY import without both preapproval (`--yes` or `-y`) and `--to` MUST fail. The CLI MUST NOT accept a filesystem path, stdin YAML body, or `--name` as a substitute for a bundle.

#### Scenario: Forced init
- **WHEN** `hwf init --force` runs against an existing `.hwf/config.yaml`
- **THEN** init overwrites without an interactive prompt

#### Scenario: Non-TTY import requires flags
- **WHEN** `hwf workflow import "<payload>"` runs without a TTY and without `--yes` and `--to`
- **THEN** the process exits nonzero asking for those flags

#### Scenario: Equals scope form
- **WHEN** `hwf workflow import "<payload>" --yes --to=repo` runs without a TTY
- **THEN** import proceeds without interactive scope prompts

#### Scenario: CLI rejects raw YAML file operand
- **WHEN** the user runs `hwf workflow import ./mine.yaml --yes --to=repo`
- **THEN** the process exits nonzero as a non-bundle payload (raw YAML is workbench-only)

### Requirement: Web route and browser control
`web` MUST accept an optional route argument of the form `w=<repo|global>:<name>`, `share=<repo|global>:<name>`, `import`, or `new`. It MUST accept optional `--port <integer>` in `1..65535` and `--no-open`, including equals forms such as `--port=8080`. A Commander option processor MUST convert and validate the port with `InvalidArgumentError`. Invalid ports and invalid routes MUST fail before starting a server. Unless `--no-open` is present, the CLI MUST attempt to open the printed URL in the platform browser, using an opener that exists on the host platform. An owned workbench process MUST stop on the host platform's termination signals, covering `SIGINT` and `SIGTERM` where the platform delivers them.

#### Scenario: No browser open
- **WHEN** the user runs `hwf web --no-open`
- **THEN** the server starts and prints its URL without opening a browser

#### Scenario: Bad port
- **WHEN** the user runs `hwf web --port 0`
- **THEN** the process exits nonzero naming the invalid port

#### Scenario: Invalid route rejected early
- **WHEN** the user runs `hwf web http://evil.example --no-open`
- **THEN** the process exits nonzero naming the route expectation and does not start a server

#### Scenario: New workflow route
- **WHEN** the user runs `hwf web new --no-open`
- **THEN** the server starts with the new-workflow route and does not reject the route

#### Scenario: Browser opens on every supported platform
- **WHEN** a workbench route is launched without `--no-open` on macOS or Linux
- **THEN** the CLI invokes an opener available on that platform and the workbench reaches the browser

#### Scenario: Opener absence does not hide the URL
- **WHEN** no browser opener can be launched from an interactive `hwf web` invocation
- **THEN** the printed URL still reaches the user through a stream the caller observes

#### Scenario: Detached picker handoff ignores launcher stdout
- **WHEN** the picker launches a detached `hwf web <route>` child
- **THEN** the child does not inherit the picker's stdout, so tearing down the picker popup cannot abort the child before it opens the browser, and the child's stderr is retained in plugin state when that path is writable (otherwise ignored without blocking the handoff)
