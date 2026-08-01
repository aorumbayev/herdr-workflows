## MODIFIED Requirements

### Requirement: Tolerated failure
`continue_on_error: true` MUST record an action failure and continue to the next step without invoking `on_failure`. A spawned local command MUST always expose its structured result after process exit, so a later step may reference it even when the exit code is nonzero. The loader MUST reject references to a `continue_on_error` agent, Herdr, workflow, placed, readiness, or background action, because those actions might fail without a natural result. Process spawn and runner infrastructure failures MUST stay hard failures because they produce no command result. A tolerated failure MUST still make the complete run fail and the CLI exit nonzero after remaining steps finish. It MUST differ from a hard failure only by continuing and suppressing recovery.

#### Scenario: Best-effort cleanup
- **WHEN** a cleanup Herdr action fails with `continue_on_error: true`
- **THEN** later steps run and the private per-run snapshot history retains the cleanup failure

#### Scenario: Tolerated command result
- **WHEN** a local command exits nonzero with `continue_on_error: true`
- **THEN** a later step may inspect its `failed`, `exit_code`, `stdout`, and `stderr`
