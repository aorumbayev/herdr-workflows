## MODIFIED Requirements

### Requirement: Canonical invocation context
Context MUST expose stable `workspace`, `tab`, `pane`, `worktree`, `agent`, `selection`, and `platform`, plus plugin-produced `transcript` and `transcript_file`. Platform MUST be `macos`, `linux`, or `windows`. Selection MUST be empty when absent. Referencing unavailable identity or transcript values MUST fail preflight. Transcript values MUST have a hard size cap. They MUST never enter automatic shell env or private per-run snapshot history, and import/editing surfaces MUST mark them visibly sensitive. Run cleanup MUST remove the transcript file on every path, and MUST start only after recovery completes. Run cleanup MUST remove managed response files only when the run succeeds, so a failed run keeps the agent output a step already wrote. `context.error` MUST exist only during recovery.

#### Scenario: Explicit transcript handoff
- **WHEN** reviewed YAML embeds `{{context.transcript}}` in a managed agent prompt
- **THEN** capped transcript text is sent to that profile without an additional runtime confirmation

#### Scenario: Failed run keeps managed output
- **WHEN** an agent step fails and the agent has written its managed response file
- **THEN** run cleanup removes the transcript file and keeps the managed response file on disk

#### Scenario: Recovery reads the transcript
- **WHEN** an `on_failure` step reads `{{context.transcript_file}}`
- **THEN** the transcript file still exists, because cleanup waits for recovery to finish
