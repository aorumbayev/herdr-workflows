## MODIFIED Requirements

### Requirement: Public command surface

The `hwf` / `herdr-workflows` entrypoint MUST expose operational commands `run`, `init`, `workflow`, `launch`, `picker`, `console`, `update`, `skills`, `response`, and `scratch`. `workflow` MUST expose nested `import`, `inspect <name>`, and `validate <file> [name]`. `skills` MUST expose nested `list` and `show <name>`. `response` MUST expose nested `check <file>`. `scratch` MUST expose nested `get <key>`, `set <key> <value>`, `list`, and `delete <key>`. The CLI MUST retain Cobra's generated `help [command]`, `-h`, and `--help` interfaces. It MUST expose `-V` and `--version` with the version from `herdr-plugin.toml`. Generated root help MUST describe the product without presenting `v1alpha1` as the application or Herdr version, and MUST label `v1alpha1` separately as the workflow format. Unknown commands and options MUST use Cobra-native errors and suggestions. The implementation MUST NOT suppress or reconstruct Cobra parse diagnostics. The CLI MUST use Cobra as the argv parser and dispatcher without a parallel hand-rolled parser, duplicate command model, command factory, or one-use command interface. `skills list` MUST print each bundled skill's name and the one-line description from its frontmatter. `skills show <name>` MUST print the skill's `SKILL.md` and its `reference/` and `scripts/` files with file-path headers, and MUST exit nonzero naming the available skills for an unknown name. Skill text MUST be embedded into the binary at build time so a compiled install serves it without the repository checkout. The `skills`, `workflow validate`, `response`, and `scratch` commands MUST NOT contact Herdr and MUST NOT run the version or protocol preflight.

#### Scenario: Known commands

- **WHEN** the user invokes `hwf run`, `hwf init`, `hwf workflow import`, `hwf workflow inspect <name>`, `hwf workflow validate <file>`, `hwf launch`, `hwf picker`, `hwf console`, `hwf update`, `hwf skills list`, `hwf skills show <name>`, `hwf response check <file>`, `hwf scratch get <key>`, `hwf scratch set <key> <value>`, `hwf scratch list`, or `hwf scratch delete <key>`
- **THEN** the matching command handler runs

#### Scenario: Scratch offline

- **WHEN** `hwf scratch list` runs with no reachable Herdr server
- **THEN** the command completes without contacting Herdr or running protocol preflight

#### Scenario: Unknown command
- **WHEN** the user invokes `hwf nope`
- **THEN** Cobra exits nonzero and writes its unknown-command diagnostic and any matching suggestion to stderr

#### Scenario: Unknown option
- **WHEN** the user invokes `hwf run demo --not-a-real-flag`
- **THEN** Cobra exits nonzero and writes its unknown-option diagnostic to stderr

#### Scenario: Generated command help
- **WHEN** the user invokes `hwf help run` or `hwf run --help`
- **THEN** Cobra prints generated help from the declared run arguments and options

#### Scenario: Plugin version
- **WHEN** the user invokes `hwf --version` or `hwf -V`
- **THEN** Cobra prints the plugin version from `herdr-plugin.toml`

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
