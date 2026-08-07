# hwf-cli Delta

## MODIFIED Requirements

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
