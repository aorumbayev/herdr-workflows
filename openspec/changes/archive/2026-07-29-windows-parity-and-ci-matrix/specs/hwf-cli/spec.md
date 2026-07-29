## MODIFIED Requirements

### Requirement: Public command surface
The `hwf` / `herdr-workflows` entrypoint MUST expose operational commands `run`, `init`, `workflow`, `launch`, `picker`, `web`, and `update`. `workflow` MUST expose nested `import`. The CLI MUST retain Commander's generated `help [command]`, `-h`, and `--help` interfaces. It MUST expose `-V` and `--version` with the version from `herdr-plugin.toml`. Generated root help MUST describe the product without presenting `v1alpha1` as the application or Herdr version, and MUST label `v1alpha1` separately as the workflow format. Unknown commands and options MUST use Commander-native errors and suggestions. The implementation MUST NOT suppress or reconstruct Commander parse diagnostics. The CLI MUST use Commander as the argv parser and dispatcher without a parallel hand-rolled parser, duplicate command model, command factory, or one-use command interface.

#### Scenario: Known commands
- **WHEN** the user invokes `hwf run`, `hwf init`, `hwf workflow import`, `hwf launch`, `hwf picker`, `hwf web`, or `hwf update`
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

### Requirement: Web route and browser control
`web` MUST accept an optional route argument of the form `w=<repo|global>:<name>`, `share=<repo|global>:<name>`, or `import`. It MUST accept optional `--port <integer>` in `1..65535` and `--no-open`, including equals forms such as `--port=8080`. A Commander option processor MUST convert and validate the port with `InvalidArgumentError`. Invalid ports and invalid routes MUST fail before starting a server. Unless `--no-open` is present, the CLI MUST attempt to open the printed URL in the platform browser, using an opener that exists on the host platform. An owned workbench process MUST stop on the host platform's termination signals, covering `SIGINT` and `SIGTERM` where the platform delivers them.

#### Scenario: No browser open
- **WHEN** the user runs `hwf web --no-open`
- **THEN** the server starts and prints its URL without opening a browser

#### Scenario: Bad port
- **WHEN** the user runs `hwf web --port 0`
- **THEN** the process exits nonzero naming the invalid port

#### Scenario: Invalid route rejected early
- **WHEN** the user runs `hwf web http://evil.example --no-open`
- **THEN** the process exits nonzero naming the route expectation and does not start a server

#### Scenario: Browser opens on every supported platform
- **WHEN** a workbench route is launched without `--no-open` on macOS or Linux
- **THEN** the CLI invokes an opener available on that platform and the workbench reaches the browser

#### Scenario: Opener absence does not hide the URL
- **WHEN** no browser opener can be launched
- **THEN** the printed URL still reaches the user through a stream the caller observes

### Requirement: Detached self-launch argv compatibility
Detached `hwf run` launches MUST keep argv shape `run <name> --launch-payload` with the launch payload on stdin, never on argv. Detached `hwf web` launches MUST keep argv shape `web <route>`. Compiled-binary and Bun script entry re-exec rules in the launch helper MUST stay unchanged. A detached run whose outcome the caller awaits MUST settle that outcome on every supported platform, including after the caller stops observing progress, and MUST NOT depend on an unreferenced child handle continuing to report exit or stream end. Detaching MUST still release the caller, so a launcher process MUST NOT stay alive for the remaining lifetime of its child.

#### Scenario: Detached run argv omits secrets
- **WHEN** the picker launches a detached run with secret inputs
- **THEN** the child argv contains `--launch-payload` and does not contain input values

#### Scenario: Completion resolves after mid-run detach
- **WHEN** the picker detaches from an in-flight detached run on macOS or Linux
- **THEN** the awaited outcome resolves and the child runs to completion

#### Scenario: Launcher exits after detach
- **WHEN** the picker dismisses while a detached run is still executing
- **THEN** the picker process exits without waiting for the child, and the run outcome still reaches the run log

## ADDED Requirements

### Requirement: Managed plugin update
`hwf update` MUST check the latest published GitHub Release without considering drafts, validate its tag as a plugin semver, and compare it with the version embedded from `herdr-plugin.toml`. It MUST report success without reinstalling when the installed version is current or newer. For a newer release installed from a Herdr-managed GitHub checkout, it MUST change its working directory outside `HERDR_PLUGIN_ROOT` and synchronously invoke `herdr plugin install aorumbayev/herdr-workflows --yes`, forwarding output and failure status. It MUST refuse to overwrite a linked development checkout and direct the developer to `bun run install:dev`. It MUST explain that an unregistered or directly copied binary must first be installed through Herdr.

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
