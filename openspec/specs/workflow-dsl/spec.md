## Requirements

### Requirement: Text-buffer validator entry point
The plugin SHALL expose a single validator, `parseWorkflowText(name, yaml, agents)`, that performs the full workflow load/validate path (parse, flatten, placeholder bans, input checks, agent checks) on an in-memory YAML buffer. The file loader SHALL read the file and delegate to this function so that file-based and buffer-based validation share one code path and produce identical positioned errors.

#### Scenario: Buffer and file validation agree
- **WHEN** the same YAML is validated as an on-disk file and as an in-memory buffer with the same declared agents
- **THEN** both produce the same result and, on failure, the same positioned error message

### Requirement: Linear workflow verbs
The plugin SHALL execute workflows as an ordered list of steps where each step uses exactly one verb among `shell`, `open`, `agent`, and `herdr`, plus load-time `run` composition.

#### Scenario: One verb per step
- **WHEN** a step declares more than one of `shell`, `open`, `agent`, `herdr`
- **THEN** workflow load fails with a positioned error

### Requirement: Placeholder safety ban in commands
The plugin SHALL reject placeholders in `shell:` and `open:` command strings at load time. Placeholders SHALL be allowed only in `stdin`, `prompt`, and `params` string values (with `{session}` / `{session_file}` restricted to `stdin`).

#### Scenario: Pane placeholder in shell command rejected
- **WHEN** a step sets `shell: "echo {pane}"`
- **THEN** load fails stating placeholders are not allowed in command strings

#### Scenario: Session only in stdin
- **WHEN** a step sets `agent` `prompt` containing `{session}`
- **THEN** load fails stating `{session}` is only allowed in `stdin`

### Requirement: Shell input env export
When executing a `shell` step, the plugin SHALL export each resolved workflow input as environment variable `HWF_INPUT_<name>` (value as collected), in addition to existing stdin/placeholder substitution. Command text MUST NOT gain new placeholder interpolation rights.

#### Scenario: Worktree reads branch from env
- **WHEN** workflow input `branch` is `feat/x` and step is `shell: 'herdr worktree create --branch "$HWF_INPUT_branch" --base "$HWF_INPUT_base" --focus'`
- **THEN** the shell process environment includes `HWF_INPUT_branch=feat/x` and the corresponding base input

### Requirement: Agent close_source
An `agent` step MAY set `close_source: true`. After the target agent pane/tab is successfully created, the plugin SHALL close the invoking context `tabId` when present. On create failure, the source tab MUST remain open.

#### Scenario: Close after successful agent open
- **WHEN** an `agent` step with `close_source: true` opens successfully and invocation has a `tabId`
- **THEN** that `tabId` is closed after open succeeds

#### Scenario: Keep source on open failure
- **WHEN** an `agent` step with `close_source: true` fails during open
- **THEN** the invoking tab is not closed
