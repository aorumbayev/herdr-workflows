## ADDED Requirements

### Requirement: Native Herdr agent profiles
Configuration accepts only `profiles`, `default_profile`, and `transcripts` at top level. It rejects
legacy `agents` and `sessions`. Profiles map names matching `[a-z][a-z0-9_-]{0,31}` to strict objects
containing required `kind` and optional string-list `args`. Kind must be one of the native agent kinds
that the live Herdr `agent.start` operation accepts. The API schema does not enumerate kinds, so
configuration requires a non-empty kind, and native start stays authoritative. Arbitrary command argv and
`{{prompt}}` sentinels are not profile syntax.

#### Scenario: Role profile
- **WHEN** `deep-review` declares kind `claude` and model args
- **THEN** managed agent actions pass that kind and args to native Herdr `agent.start`

#### Scenario: Unsupported kind
- **WHEN** a profile names a kind unsupported by live Herdr
- **THEN** native `agent.start` rejects it and the step fails without launching an arbitrary command

### Requirement: Plugin-owned global configuration
Global config lives at `$HERDR_PLUGIN_CONFIG_DIR/config.yaml`. When that environment variable is absent,
standalone `hwf` discovers the directory through the installed Herdr CLI/plugin registry. The
implementation must not introduce `~/.hwf/config.yaml` as a second global home.

#### Scenario: CLI outside plugin invocation
- **WHEN** `hwf` starts without injected plugin environment
- **THEN** it resolves the registered plugin config directory before loading global config

### Requirement: Layered complete replacement
Configuration merges global plugin config, committed `.hwf/config.yaml`, and gitignored
`.hwf/config.local.yaml`, in that precedence order. Higher-precedence profiles and transcript extractors
replace complete lower-precedence entries by name. The highest-precedence declared `default_profile`
wins and resolves to a merged profile. `hwf init` makes sure the local file stays ignored and does not
overwrite committed config without explicit consent.

#### Scenario: Local provider preference
- **WHEN** committed `implementation` uses Claude and local `implementation` uses Codex
- **THEN** the complete local kind and args replace the shared profile

### Requirement: Profile input discovery
Profile inputs list merged profile names in deterministic order. Defaults and selected values resolve to
merged profiles. An agent action that omits both `using` and `target` uses the merged `default_profile`.
Preflight fails when no valid default exists.

#### Scenario: Adaptive profile input
- **WHEN** merged config contains three profiles
- **THEN** the picker offers those names without exposing native args

### Requirement: Kind-keyed transcript extraction
`transcripts:` maps native Herdr kinds to strict extractor definitions containing a direct argv
`command`. Extractors receive `HWF_TRANSCRIPT_PANE_ID`, `HWF_TRANSCRIPT_AGENT_KIND`,
`HWF_TRANSCRIPT_CWD`, and, when Herdr reports them, `HWF_TRANSCRIPT_SESSION_KIND` and
`HWF_TRANSCRIPT_SESSION_VALUE`. Extractors emit transcript text to stdout and stay optional. Referencing
transcript context without an extractor or built-in support for the detected invoking kind fails
preflight. Extractor output must be non-empty and stay within the shared 8 MiB capture cap before
workflow use. Agent-reported cwd supplies `HWF_TRANSCRIPT_CWD`. Workflow invocation cwd is the fallback
when agent cwd is absent. A configured extractor replaces built-in extraction for that kind. Extractors
time out after 30 seconds and get terminated as a process group.

#### Scenario: Claude transcript
- **WHEN** an invoking Claude pane has configured or built-in extraction and a workflow needs transcript
- **THEN** the runner captures capped stdout as `context.transcript` and writes the run-owned transcript file

### Requirement: Workflow files are reviewed executable code
Repo workflows carry the same trust as the repository's own scripts. Imported global workflows display
full YAML and require explicit confirmation before writing. Merely opening a repository never executes a
workflow. Picker and workbench identify repo/global provenance. Import and editing surfaces highlight run
actions, transcript references, and sensitive Herdr actions. Neither surface claims per-run transcript
confirmation or a sandbox.

#### Scenario: Import with transcript access
- **WHEN** an imported workflow references `context.transcript`
- **THEN** the preview visibly marks that sensitive reference before confirmation
