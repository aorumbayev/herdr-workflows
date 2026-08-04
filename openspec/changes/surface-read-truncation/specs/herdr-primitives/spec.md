## MODIFIED Requirements

### Requirement: Generated request and result validation
The loader MUST generate method existence, params, protocol number, and success-result checks from the vendored Herdr API schema. Loading MUST reject unknown params, wrong types, and missing required params. Before input collection or execution, startup MUST reject a live Herdr version below the plugin manifest minimum or a protocol mismatch. The rejection MUST name the installed and required versions and both protocols. Socket calls MUST address the Unix domain socket Herdr serves at `HERDR_SOCKET_PATH`. A transport failure MUST name the unreachable Herdr and the resolved address, and MUST be distinguishable from a version rejection, a protocol rejection, and a workflow authoring error. Workflow YAML MUST NOT duplicate a Herdr version requirement. A successful action MUST keep the complete structured result as its natural step result. When a success result reports omitted older terminal rows through `read.truncated`, the runner MUST mark the step outcome truncated. It MUST NOT fail the step and MUST NOT alter the captured result. A placed readiness read that reports omitted rows MUST mark its step outcome the same way.

#### Scenario: Wrong param type
- **WHEN** `pane.split` receives text for numeric `ratio`
- **THEN** loading fails with a generated type error

#### Scenario: Structured result reference
- **WHEN** `worktree.create` succeeds under step ID `tree`
- **THEN** a later step may reference a schema-valid field such as `{{steps.tree.worktree.path}}`

#### Scenario: Variant-specific result path
- **WHEN** a referenced path exists in at least one generated success variant but not the result received
- **THEN** the action fails at runtime and names the actual result variant and missing path

#### Scenario: Preflight reaches Herdr on every supported platform
- **WHEN** a live compatible Herdr is listening and a workflow starts on macOS or Linux
- **THEN** preflight succeeds and execution proceeds to the first step

#### Scenario: Transport failure is named as such
- **WHEN** the configured socket address cannot be reached
- **THEN** the failure identifies an unreachable Herdr and the resolved address rather than a version mismatch or a workflow error

#### Scenario: Truncated read succeeds with a marked outcome
- **WHEN** a `pane.read` or `agent.read` action succeeds with `read.truncated: true`
- **THEN** the step succeeds, keeps the complete structured result, and its outcome is marked truncated
