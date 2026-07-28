# hwf-cli Specification

## Purpose

Public `hwf` / `herdr-workflows` command surface, generated help, options, default behavior, protocol preflight, and detached launch compatibility.

## Requirements
### Requirement: Public command surface
The `hwf` / `herdr-workflows` entrypoint MUST expose operational commands `run`, `init`, `workflow`, `launch`, `picker`, and `web`. `workflow` MUST expose nested `import`. The CLI MUST retain Commander's generated `help [command]`, `-h`, and `--help` interfaces. It MUST expose `-V` and `--version` with the version from `herdr-plugin.toml`. Generated root help MUST describe the product without presenting `v1alpha1` as the application or Herdr version, and MUST label `v1alpha1` separately as the workflow format. Unknown commands and options MUST use Commander-native errors and suggestions. The implementation MUST NOT suppress or reconstruct Commander parse diagnostics. The CLI MUST use Commander as the argv parser and dispatcher without a parallel hand-rolled parser, duplicate command model, command factory, or one-use command interface.

#### Scenario: Known commands
- **WHEN** the user invokes `hwf run`, `hwf init`, `hwf workflow import`, `hwf launch`, `hwf picker`, or `hwf web`
- **THEN** the matching command handler runs

#### Scenario: Unknown command
- **WHEN** the user invokes `hwf nope`
- **THEN** Commander exits nonzero and writes its unknown-command diagnostic and any matching suggestion to stderr

#### Scenario: Unknown option
- **WHEN** the user invokes `hwf run demo --not-a-real-flag`
- **THEN** Commander exits nonzero and writes its unknown-option diagnostic to stderr

#### Scenario: Generated command help
- **WHEN** the user invokes `hwf help run` or `hwf run --help`
- **THEN** Commander prints generated help from the declared run arguments and options

#### Scenario: Plugin version
- **WHEN** the user invokes `hwf --version` or `hwf -V`
- **THEN** Commander prints the plugin version from `herdr-plugin.toml`

#### Scenario: Workflow format in help
- **WHEN** the user invokes `hwf --help`
- **THEN** help labels `v1alpha1` as the workflow format separately from the product description and plugin version

### Requirement: Default no-args opens web on a TTY
When no command is supplied and both stdin and stdout are TTYs, the CLI MUST start the web UI, equivalent to `web` with default options. Commander MUST own this no-subcommand dispatch. When no command is supplied and either stream is not a TTY, the CLI MUST display generated help as an error, exit nonzero, and MUST NOT start the web server.

#### Scenario: Interactive default
- **WHEN** `hwf` is invoked with no arguments on a TTY
- **THEN** Commander dispatches the `web` command and the web server starts

#### Scenario: Non-interactive default
- **WHEN** `hwf` is invoked with no arguments without a TTY
- **THEN** Commander displays generated help as an error, the process exits nonzero, and no web port is bound

### Requirement: Run command options and launch payload
`run` MUST require a workflow name argument. It MUST accept zero or more `--input <name=value>` flags and optional `--launch-payload`. A Commander option processor MUST validate and collect each input. Repeated `--input` flags MUST merge into one input map. A value missing `=` or with an empty name MUST throw `InvalidArgumentError`. `--flag=value` forms such as `--input=a=1` MUST work. When `--launch-payload` is set, the CLI MUST read a JSON launch payload from stdin, require its `name` to match the run name, seed inputs from that payload, and then apply `--input` overrides. Empty `HERDR_WORKFLOWS_REPO_ROOT` MUST be treated as unset.

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

### Requirement: Herdr protocol preflight ordering
Commander MUST validate argv before command handlers run. After successful parsing, `run`, `picker`, and `launch` MUST call Herdr protocol and minimum-version preflight before reading a launch payload, resolving workflow inputs, executing a workflow, or loading picker UI. A protocol mismatch or too-old version MUST fail naming installed and required values before any workflow missing-input or execution error.

#### Scenario: Protocol mismatch before missing input
- **WHEN** `hwf run needs-input` runs against a socket with the wrong protocol and the workflow declares a required input that is absent
- **THEN** the process exits nonzero with a protocol mismatch error and does not report the missing input

### Requirement: Init and import consent flags
`init` MUST accept `--force` as overwrite consent without prompting. It MUST also accept `--global`. `workflow import` MUST require a payload argument and MUST accept `--to=repo|global` or `--to <scope>`, `--yes` / `-y`, and `--force`. The `--to` option MUST use a Commander `Option` choice for `repo` or `global`. Non-TTY import without both preapproval (`--yes` or `-y`) and `--to` MUST fail.

#### Scenario: Forced init
- **WHEN** `hwf init --force` runs against an existing `.hwf/config.yaml`
- **THEN** init overwrites without an interactive prompt

#### Scenario: Non-TTY import requires flags
- **WHEN** `hwf workflow import "<payload>"` runs without a TTY and without `--yes` and `--to`
- **THEN** the process exits nonzero asking for those flags

#### Scenario: Equals scope form
- **WHEN** `hwf workflow import "<payload>" --yes --to=repo` runs without a TTY
- **THEN** import proceeds without interactive scope prompts

### Requirement: Web route and browser control
`web` MUST accept an optional route argument of the form `w=<repo|global>:<name>`, `share=<repo|global>:<name>`, or `import`. It MUST accept optional `--port <integer>` in `1..65535` and `--no-open`, including equals forms such as `--port=8080`. A Commander option processor MUST convert and validate the port with `InvalidArgumentError`. Invalid ports and invalid routes MUST fail before starting a server. Unless `--no-open` is present, the CLI MUST attempt to open the printed URL in the platform browser. An owned workbench process MUST stop on `SIGINT` or `SIGTERM`.

#### Scenario: No browser open
- **WHEN** the user runs `hwf web --no-open`
- **THEN** the server starts and prints its URL without opening a browser

#### Scenario: Bad port
- **WHEN** the user runs `hwf web --port 0`
- **THEN** the process exits nonzero naming the invalid port

#### Scenario: Invalid route rejected early
- **WHEN** the user runs `hwf web http://evil.example --no-open`
- **THEN** the process exits nonzero naming the route expectation and does not start a server

### Requirement: Picker stays lazily loaded
The `picker` command MUST dynamically import the TUI module only when that command is selected. Program construction and other commands MUST NOT load `@opentui/core` through the picker module.

#### Scenario: Run does not load picker
- **WHEN** the user runs `hwf run <name>`
- **THEN** the process does not import `src/tui/picker` for that invocation

### Requirement: Detached self-launch argv compatibility
Detached `hwf run` launches MUST keep argv shape `run <name> --launch-payload` with the launch payload on stdin, never on argv. Detached `hwf web` launches MUST keep argv shape `web <route>`. Compiled-binary and Bun script entry re-exec rules in the launch helper MUST stay unchanged.

#### Scenario: Detached run argv omits secrets
- **WHEN** the picker launches a detached run with secret inputs
- **THEN** the child argv contains `--launch-payload` and does not contain input values
