## MODIFIED Requirements

### Requirement: Run command options and launch payload
`run` MUST require a workflow name argument. It MUST accept zero or more `--input <name=value>` flags and optional `--launch-payload`. A Commander option processor MUST validate and collect each input. Repeated `--input` flags MUST merge into one input map. A value missing `=` or with an empty name MUST throw `InvalidArgumentError`. `--flag=value` forms such as `--input=a=1` MUST work. When `--launch-payload` is set, the CLI MUST read a JSON launch payload from stdin, require its `name` to match the run name, seed inputs from that payload, and then apply `--input` overrides. The private launch payload MAY carry a complete run UUID allocated by the picker. The child MUST validate and exclusively claim that UUID for its snapshot. without one the runner MUST generate and claim its own full UUID. Empty `HERDR_WORKFLOWS_REPO_ROOT` MUST be treated as unset.

#### Scenario: Repeatable inputs
- **WHEN** the user runs `hwf run demo --input a=1 --input b=2`
- **THEN** the workflow receives inputs `a=1` and `b=2`

#### Scenario: Equals syntax input
- **WHEN** the user runs `hwf run demo --input=a=1`
- **THEN** the workflow receives input `a=1`

#### Scenario: Invalid input flag
- **WHEN** the user runs `hwf run demo --input novalue`
- **THEN** the process exits nonzero naming the bad `--input` value

#### Scenario: Missing run name
- **WHEN** the user runs `hwf run` with no workflow name
- **THEN** the process exits nonzero

#### Scenario: Launch payload then input override
- **WHEN** the user runs `hwf run demo --launch-payload` with stdin JSON `{"name":"demo","inputs":{"a":"1"}}` and also passes `--input a=2`
- **THEN** the workflow receives input `a=2`

#### Scenario: Picker supplies run identity
- **WHEN** a detached picker launch supplies a complete run UUID in its private stdin payload
- **THEN** the child exclusively claims that UUID for the run snapshot

#### Scenario: Invalid supplied run identity
- **WHEN** a launch payload supplies a short or malformed run UUID
- **THEN** the child exits nonzero before executing a workflow step

#### Scenario: Supplied run identity is already claimed
- **WHEN** a launch payload supplies a complete UUID whose snapshot already exists
- **THEN** the child exits nonzero before executing a workflow step

### Requirement: Web route and browser control
`web` MUST accept an optional route argument of the form `w=<repo|global>:<name>`, `share=<repo|global>:<name>`, `run=<uuid>`, `import`, or `new`. It MUST accept optional `--port <integer>` in `1..65535` and `--no-open`, including equals forms such as `--port=8080`. A Commander option processor MUST convert and validate the port with `InvalidArgumentError`. Invalid ports and invalid routes MUST fail before starting a server. A run route MUST require a complete UUID and MUST NOT accept a displayed prefix. Unless `--no-open` is present, the CLI MUST attempt to open the printed URL in the platform browser, using an opener that exists on the host platform. An owned workbench process MUST stop on the host platform's termination signals, covering `SIGINT` and `SIGTERM` where the platform delivers them.

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

#### Scenario: Run detail route
- **WHEN** the user runs `hwf web run=550e8400-e29b-41d4-a716-446655440000 --no-open`
- **THEN** the server starts with the authenticated run-detail hash and does not reject the route

#### Scenario: Short run identifier
- **WHEN** the user runs `hwf web run=550e8400 --no-open`
- **THEN** the process exits nonzero naming the complete-UUID requirement before starting a server

#### Scenario: Browser opens on every supported platform
- **WHEN** a workbench route is launched without `--no-open` on macOS or Linux
- **THEN** the CLI invokes an opener available on that platform and the workbench reaches the browser

#### Scenario: Opener absence does not hide the URL
- **WHEN** no browser opener can be launched from an interactive `hwf web` invocation
- **THEN** the printed URL still reaches the user through a stream the caller observes

#### Scenario: Detached picker handoff ignores launcher stdout
- **WHEN** the picker launches a detached `hwf web <route>` child
- **THEN** the child does not inherit the picker's stdout, so tearing down the picker popup cannot abort the child before it opens the browser, and the child's stderr is retained in plugin state when that path is writable (otherwise ignored without blocking the handoff)
