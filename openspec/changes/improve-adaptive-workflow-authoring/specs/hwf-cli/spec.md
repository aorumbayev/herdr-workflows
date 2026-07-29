## ADDED Requirements

### Requirement: Workflow input inspection
`workflow` MUST expose `inspect <name>`. Inspection MUST print each declared input in declaration order with its type, description, condition, default, minimum length, custom-value policy, and static options or dynamic-choice argv. It MUST NOT execute dynamic choices unless `--resolve` is supplied. It MUST accept repeatable `--input <name=value>` values to select guarded input paths. With `--resolve`, it MUST resolve only active dynamic choices under the ordinary repository root, timeout, option-count, stderr, and capture rules. Inspection MUST NOT execute workflow steps or require Herdr protocol preflight.

#### Scenario: Inspect without executing discovery
- **WHEN** a workflow has a dynamic choice and the user runs `hwf workflow inspect <name>`
- **THEN** the CLI prints the dynamic argv and does not execute it

#### Scenario: Inspect one guarded path
- **WHEN** the user supplies `--input mode=delete --resolve`
- **THEN** the CLI prints and resolves delete-active inputs without resolving create-only inputs

### Requirement: Detached launch preserves resolved input domains
The picker launch payload on stdin MAY include resolved dynamic option arrays. A detached run receiving those arrays MUST validate their input names and kinds, MUST validate selected values against them, and MUST NOT rerun their discovery commands. Launch payload values MUST remain absent from argv, and explicit CLI `--input` values MUST retain their existing override behavior.

#### Scenario: Dynamic options remain private and stable
- **WHEN** the picker launches a workflow after resolving a dynamic input
- **THEN** the selected value and resolved domain travel on stdin, no value appears on argv, and the detached run uses that domain without re-execution
