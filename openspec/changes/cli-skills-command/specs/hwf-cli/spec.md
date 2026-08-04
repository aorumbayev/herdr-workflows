## MODIFIED Requirements

### Requirement: Public command surface
The `hwf` / `herdr-workflows` entrypoint MUST expose operational commands `run`, `init`, `workflow`, `launch`, `picker`, `web`, `update`, and `skills`. `workflow` MUST expose nested `import`. `skills` MUST expose nested `list` and `show <name>`. The CLI MUST retain Commander's generated `help [command]`, `-h`, and `--help` interfaces. It MUST expose `-V` and `--version` with the version from `herdr-plugin.toml`. Generated root help MUST describe the product without presenting `v1alpha1` as the application or Herdr version, and MUST label `v1alpha1` separately as the workflow format. Unknown commands and options MUST use Commander-native errors and suggestions. The implementation MUST NOT suppress or reconstruct Commander parse diagnostics. The CLI MUST use Commander as the argv parser and dispatcher without a parallel hand-rolled parser, duplicate command model, command factory, or one-use command interface. `skills list` MUST print each bundled skill's name and the one-line description from its frontmatter. `skills show <name>` MUST print the skill's `SKILL.md` and its `reference/` and `scripts/` files with file-path headers, and MUST exit nonzero naming the available skills for an unknown name. Skill text MUST be embedded into the binary at build time so a compiled install serves it without the repository checkout. The `skills` commands MUST NOT contact Herdr and MUST NOT run the version or protocol preflight.

#### Scenario: Known commands
- **WHEN** the user invokes `hwf run`, `hwf init`, `hwf workflow import`, `hwf launch`, `hwf picker`, `hwf web`, `hwf update`, `hwf skills list`, or `hwf skills show <name>`
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
