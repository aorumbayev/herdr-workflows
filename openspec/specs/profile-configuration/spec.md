# profile-configuration Specification

## Purpose
Native Herdr agent profiles, plugin-owned layered config, and kind-keyed transcript extraction.

## Requirements
### Requirement: Native Herdr agent profiles
Configuration MUST accept only `profiles`, `default_profile`, and `transcripts` at top level. It MUST reject `agents` and `sessions`. Profiles MUST map names matching `[a-z][a-z0-9_-]{0,31}` to strict objects containing required `kind` and optional string-list `args`. Kind MUST be one of the native agent kinds that the live Herdr `agent.start` operation accepts. The API schema does not enumerate kinds, so configuration MUST require a non-empty kind, and native start MUST stay authoritative. Arbitrary command argv and `{{prompt}}` sentinels MUST NOT be profile syntax.

#### Scenario: Role profile
- **WHEN** `deep-review` declares kind `claude` and model args
- **THEN** managed agent actions pass that kind and args to native Herdr `agent.start`

#### Scenario: Unsupported kind
- **WHEN** a profile names a kind unsupported by live Herdr
- **THEN** native `agent.start` rejects it and the step fails without launching an arbitrary command

### Requirement: Plugin-owned global configuration
Global config MUST live at `$HERDR_PLUGIN_CONFIG_DIR/config.yaml`. When that environment variable is absent, standalone `hwf` MUST discover the directory through the installed Herdr CLI/plugin registry. The implementation MUST NOT introduce `~/.hwf/config.yaml` as a second global home.

#### Scenario: CLI outside plugin invocation
- **WHEN** `hwf` starts without injected plugin environment
- **THEN** it resolves the registered plugin config directory before loading global config

### Requirement: Layered complete replacement
Configuration MUST merge global plugin config, committed `.hwf/config.yaml`, and gitignored `.hwf/config.local.yaml`, in that precedence order. Higher-precedence profiles and transcript extractors MUST replace complete lower-precedence entries by name. The highest-precedence declared `default_profile` MUST win and resolve to a merged profile. `hwf init` MUST make sure the local file stays ignored and MUST NOT overwrite committed config without explicit consent.

#### Scenario: Local provider preference
- **WHEN** committed `implementation` uses Claude and local `implementation` uses Codex
- **THEN** the complete local kind and args replace the shared profile

### Requirement: Profile input discovery
Profile inputs MUST list merged profile names in deterministic order. Defaults and selected values MUST resolve to merged profiles. An agent action that omits both `using` and `target` MUST use the merged `default_profile`. Preflight MUST fail when no valid default exists.

#### Scenario: Adaptive profile input
- **WHEN** merged config contains three profiles
- **THEN** the picker offers those names without exposing native args

### Requirement: Kind-keyed transcript extraction
`transcripts:` MUST map native Herdr kinds to strict extractor definitions containing a direct argv `command`. Extractors MUST receive `HWF_TRANSCRIPT_PANE_ID`, `HWF_TRANSCRIPT_AGENT_KIND`, `HWF_TRANSCRIPT_CWD`, and, when Herdr reports them, `HWF_TRANSCRIPT_SESSION_KIND` and `HWF_TRANSCRIPT_SESSION_VALUE`. Extractors MUST emit transcript text to stdout and stay optional. Referencing transcript context without an extractor or built-in support for the detected invoking kind MUST fail preflight. Extractor output MUST be non-empty and stay within the shared 8 MiB capture cap before workflow use. Agent-reported cwd MUST supply `HWF_TRANSCRIPT_CWD`. Workflow invocation cwd MUST be the fallback when agent cwd is absent. A configured extractor MUST replace built-in extraction for that kind. Extractors MUST time out after 30 seconds and get terminated as a process group.

#### Scenario: Claude transcript
- **WHEN** an invoking Claude pane has configured or built-in extraction and a workflow needs transcript
- **THEN** the runner captures capped stdout as `context.transcript` and writes the run-owned transcript file

### Requirement: Workflow files are reviewed executable code
Repo workflows MUST carry the same trust as the repository's own scripts. Imported global workflows MUST display full YAML and require explicit confirmation before writing. Merely opening a repository MUST never execute a workflow. Picker and workbench MUST identify repo/global provenance. Import and editing surfaces MUST highlight run actions, transcript references, and sensitive Herdr actions. Neither surface MUST claim per-run transcript confirmation or a sandbox.

#### Scenario: Import with transcript access
- **WHEN** an imported workflow references `context.transcript`
- **THEN** the preview visibly marks that sensitive reference before confirmation
