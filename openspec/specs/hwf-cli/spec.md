# hwf-cli Specification

## Purpose

Public `hwf` / `herdr-workflows` command surface, generated help, options, default behavior, protocol preflight, and detached launch compatibility.
## Requirements
### Requirement: Public command surface
The `hwf` / `herdr-workflows` entrypoint MUST expose operational commands `run`, `init`, `workflow`, `launch`, `picker`, `web`, `update`, `skills`, and `response`. `workflow` MUST expose nested `import`. `skills` MUST expose nested `list` and `show <name>`. `response` MUST expose nested `check <file>`. The CLI MUST retain Commander's generated `help [command]`, `-h`, and `--help` interfaces. It MUST expose `-V` and `--version` with the version from `herdr-plugin.toml`. Generated root help MUST describe the product without presenting `v1alpha1` as the application or Herdr version, and MUST label `v1alpha1` separately as the workflow format. Unknown commands and options MUST use Commander-native errors and suggestions. The implementation MUST NOT suppress or reconstruct Commander parse diagnostics. The CLI MUST use Commander as the argv parser and dispatcher without a parallel hand-rolled parser, duplicate command model, command factory, or one-use command interface. `skills list` MUST print each bundled skill's name and the one-line description from its frontmatter. `skills show <name>` MUST print the skill's `SKILL.md` and its `reference/` and `scripts/` files with file-path headers, and MUST exit nonzero naming the available skills for an unknown name. Skill text MUST be embedded into the binary at build time so a compiled install serves it without the repository checkout. The `skills` and `response` commands MUST NOT contact Herdr and MUST NOT run the version or protocol preflight.

#### Scenario: Known commands
- **WHEN** the user invokes `hwf run`, `hwf init`, `hwf workflow import`, `hwf launch`, `hwf picker`, `hwf web`, `hwf update`, `hwf skills list`, `hwf skills show <name>`, or `hwf response check <file>`
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

#### Scenario: Skills list
- **WHEN** the user invokes `hwf skills list`
- **THEN** the CLI prints every bundled skill's name and frontmatter description and exits zero

#### Scenario: Skills show
- **WHEN** the user invokes `hwf skills show herdr-workflow-create`
- **THEN** the CLI prints the skill's `SKILL.md` and its `reference/` and `scripts/` files, each under a file-path header, and exits zero

#### Scenario: Unknown skill name
- **WHEN** the user invokes `hwf skills show nope`
- **THEN** the CLI exits nonzero and names the available skills

#### Scenario: Skills serve offline from a compiled install
- **WHEN** `hwf skills list` or `hwf skills show <name>` runs from a compiled binary with no repository checkout and no reachable Herdr
- **THEN** the embedded skill text prints and no Herdr connection or protocol preflight is attempted

### Requirement: Default no-args opens web on a TTY
When no command is supplied and both stdin and stdout are TTYs, the CLI MUST start the web UI, equivalent to `web` with default options. Commander MUST own this no-subcommand dispatch. When no command is supplied and either stream is not a TTY, the CLI MUST display generated help as an error, exit nonzero, and MUST NOT start the web server.

#### Scenario: Interactive default
- **WHEN** `hwf` is invoked with no arguments on a TTY
- **THEN** Commander dispatches the `web` command and the web server starts

#### Scenario: Non-interactive default
- **WHEN** `hwf` is invoked with no arguments without a TTY
- **THEN** Commander displays generated help as an error, the process exits nonzero, and no web port is bound

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

### Requirement: Herdr protocol preflight ordering
Commander MUST validate argv before command handlers run. After successful parsing, `run`, `picker`, and `launch` MUST call Herdr protocol and minimum-version preflight before reading a launch payload, resolving workflow inputs, executing a workflow, or loading picker UI. A protocol mismatch or too-old version MUST fail naming installed and required values before any workflow missing-input or execution error.

#### Scenario: Protocol mismatch before missing input
- **WHEN** `hwf run needs-input` runs against a socket with the wrong protocol and the workflow declares a required input that is absent
- **THEN** the process exits nonzero with a protocol mismatch error and does not report the missing input

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

### Requirement: Interactive import exits after prompts
When `workflow import` uses interactive confirm/scope prompts, the CLI MUST release any stdin reader acquired for those prompts after the command finishes (successful write, conflict refusal, or abort). The process MUST exit without waiting for further stdin once import has written files or aborted.

#### Scenario: TTY import exits after confirm and scope
- **WHEN** a user runs `hwf workflow import "<payload>"` on a TTY, answers confirm with `y`, and chooses repo scope
- **THEN** the process writes the workflow, prints the destination path, and exits without remaining blocked on stdin

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

### Requirement: A workbench never serves a build its client did not ask for
A client MUST NOT adopt a live workbench built from code other than the client's own, however healthy that workbench's endpoint is. A workbench whose build has a stable identity MUST record that identity, and a client MUST treat a recorded identity that differs from its own, or is absent when the client has one, as unadoptable and start its own server instead. Where the served code has no stable identity, because those sources change in place beneath a fixed runtime, the owner MUST instead stop when a source file it serves changes. Stopping MUST use the same shutdown path as termination signals, so the endpoint record is released. Neither an unavailable identity nor an unwatchable source tree MUST fail the command or prevent signal shutdown.

#### Scenario: Plugin upgrade replaces the build
- **WHEN** a workbench action runs from a build whose identity differs from the one recorded by a live owned workbench, including an upgrade that relocated the whole managed checkout rather than rewriting a file in place
- **THEN** the live workbench is not adopted and the action serves the current build from its own server

#### Scenario: Unchanged build is reused
- **WHEN** a workbench action runs from the same build as a live owned workbench for that repository
- **THEN** that workbench is adopted rather than replaced

#### Scenario: Record predates build identity
- **WHEN** a live endpoint record carries no build identity and the acting client has one
- **THEN** the record is not adopted and the action starts its own server

#### Scenario: Development source change
- **WHEN** an owned workbench was started from an on-disk script entry and a served source file under that entry's tree changes
- **THEN** that workbench stops and releases its endpoint record

#### Scenario: Unwatchable source tree
- **WHEN** a script entry's source tree cannot be watched
- **THEN** the workbench keeps serving and still stops on termination signals

### Requirement: Picker stays lazily loaded
The `picker` command MUST dynamically import the TUI module only when that command is selected. Program construction and other commands MUST NOT load `@opentui/core` through the picker module.

#### Scenario: Run does not load picker
- **WHEN** the user runs `hwf run <name>`
- **THEN** the process does not load the picker module for that invocation

### Requirement: Detached self-launch argv compatibility
Detached `hwf run` launches MUST keep argv shape `run <name> --launch-payload` with the launch payload on stdin, never on argv. Detached `hwf web` launches MUST keep argv shape `web <route>`. Compiled-binary and Bun script entry re-exec rules in the launch helper MUST stay unchanged. A detached run whose outcome the caller awaits MUST settle that outcome on every supported platform, including after the caller stops observing progress, and MUST NOT depend on an unreferenced child handle continuing to report exit or stream end. Detaching MUST still release the caller, so a launcher process MUST NOT stay alive for the remaining lifetime of its child.

While a caller observes a detached `hwf run`, the parent MUST retain only progress lines needed by the picker, history acknowledgement lines, and the final non-empty diagnostic line (or a small bounded tail) used for the awaited failure detail. It MUST NOT retain the complete aggregate stdout or stderr of the child.

#### Scenario: Detached run argv omits secrets
- **WHEN** the picker launches a detached run with secret inputs
- **THEN** the child argv contains `--launch-payload` and does not contain input values

#### Scenario: Completion resolves after mid-run detach
- **WHEN** the picker detaches from an in-flight detached run on macOS or Linux
- **THEN** the awaited outcome resolves and the child runs to completion

#### Scenario: Launcher exits after detach
- **WHEN** the picker dismisses while a detached run is still executing
- **THEN** the picker process exits without waiting for the child, and the run outcome still reaches the private per-run snapshot history

#### Scenario: Observed detached failure keeps a bounded diagnostic
- **WHEN** an observed detached `hwf run` exits nonzero with multi-line stderr
- **THEN** the awaited failure detail is the final non-empty diagnostic line (or a small bounded tail), not the complete aggregate child output

### Requirement: Managed plugin update
`hwf update` MUST check the latest published GitHub Release without considering drafts, validate its tag as a plugin semver, and compare it with the version embedded from `herdr-plugin.toml`. It MUST report success without reinstalling when the installed version is current or newer. For a newer release installed from a Herdr-managed GitHub checkout, it MUST change its working directory outside `HERDR_PLUGIN_ROOT` and synchronously invoke `herdr plugin install aorumbayev/herdr-workflows --ref <tag> --yes` with the validated release tag, forwarding output and failure status. It MUST refuse to overwrite a linked development checkout and direct the developer to `bun run install:dev`. It MUST explain that an unregistered or directly copied binary must first be installed through Herdr.

#### Scenario: Already current
- **WHEN** `hwf update` finds no published version newer than its embedded version
- **THEN** it reports that the plugin is already up to date and does not invoke plugin installation

#### Scenario: Managed update
- **WHEN** a newer published version exists and the current plugin source is a Herdr-managed GitHub checkout
- **THEN** `hwf update` leaves the managed checkout before running the Herdr install command synchronously and returns that command's result

#### Scenario: Linked development checkout
- **WHEN** `hwf update` discovers that `herdr-workflows` is locally linked
- **THEN** it makes no replacement and directs the user to `bun run install:dev`

#### Scenario: Update check fails
- **WHEN** the latest published release cannot be fetched or validated
- **THEN** `hwf update` exits nonzero with a concise update-check error and leaves the installed plugin unchanged

### Requirement: Workflow input inspection
`workflow` MUST expose `inspect <name>`. Inspection MUST print each declared input in declaration order with its type, description, condition, default, minimum length, custom-value policy, and static options or dynamic-choice argv. It MUST NOT execute dynamic choices unless `--resolve` is supplied. It MUST accept repeatable `--input <name=value>` values to select guarded input paths. With `--resolve`, it MUST resolve only active dynamic choices under the ordinary repository root, timeout, option-count, stderr, and capture rules. With `--resolve`, a dynamic choice whose argv references earlier inputs MUST resolve only when every referenced input is supplied through `--input`, and MUST otherwise print the unresolved argv without executing it. Inspection MUST NOT execute workflow steps or require Herdr protocol preflight.

#### Scenario: Inspect without executing discovery
- **WHEN** a workflow has a dynamic choice and the user runs `hwf workflow inspect <name>`
- **THEN** the CLI prints the dynamic argv and does not execute it

#### Scenario: Inspect one guarded path
- **WHEN** the user supplies `--input mode=delete --resolve`
- **THEN** the CLI prints and resolves delete-active inputs without resolving create-only inputs

#### Scenario: Dependent choice without supplied values
- **WHEN** the user runs `--resolve` and a dynamic choice references `{{inputs.repo}}` with no `--input repo=<value>` supplied
- **THEN** the CLI prints that choice's unresolved argv without executing it and resolves the independent choices normally

### Requirement: Detached launch preserves resolved input domains
The picker launch payload on stdin MAY include resolved dynamic option arrays. A detached run receiving those arrays MUST validate their input names and kinds, MUST validate selected values against them, and MUST NOT rerun their discovery commands. Launch payload values MUST remain absent from argv, and explicit CLI `--input` values MUST retain their existing override behavior.

#### Scenario: Dynamic options remain private and stable
- **WHEN** the picker launches a workflow after resolving a dynamic input
- **THEN** the selected value and resolved domain travel on stdin, no value appears on argv, and the detached run uses that domain without re-execution

### Requirement: Picker mounts when the catalog is empty
`hwf picker` / the plugin picker entrypoint MUST mount the picker UI when there are no visible workflows. It MUST NOT exit solely because the catalog is empty.

#### Scenario: Empty catalog picker
- **WHEN** `hwf picker` runs on a TTY in a repository with no visible workflows
- **THEN** the picker UI mounts instead of exiting with a no-workflows error

### Requirement: Response verdict check oracle
`hwf response check <file> --one-of <tokens>` MUST validate a response file against a verdict contract using the same parse rules as the runner's verdict gate: the final non-empty line of the file, after trimming, matched exactly against the comma-separated token list. Tokens MUST satisfy the same constraints as `expect.one_of`. On a match the command MUST exit zero and print the matched verdict. On a mismatch the command MUST exit nonzero and name the offending final line and the expected tokens. A missing or empty file MUST exit nonzero naming the path. The command MUST NOT contact Herdr, MUST NOT run the version or protocol preflight, and MUST NOT write to the file.

#### Scenario: Valid verdict
- **WHEN** the final non-empty line of the file is `APPROVE` and the command runs with `--one-of APPROVE,REJECT`
- **THEN** the command exits zero and prints `APPROVE`

#### Scenario: Decorated verdict
- **WHEN** the final non-empty line is `APPROVE — with reservations`
- **THEN** the command exits nonzero, prints the offending line, and names the expected tokens

#### Scenario: Offline oracle
- **WHEN** the command runs with no Herdr server available
- **THEN** the check completes normally without contacting Herdr

