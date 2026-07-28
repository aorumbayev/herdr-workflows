## ADDED Requirements

### Requirement: Strictly linear workflow execution
The runner processes steps in document order. It does not support loops, parallel groups, joins,
dependencies, or scheduler queues. A background action represents a launched process, not a branch. The
runner never joins a background action for a result.

#### Scenario: Ordered actions
- **WHEN** a workflow contains three blocking steps
- **THEN** each step starts only after its predecessor finishes successfully or has a tolerated failure

### Requirement: Conditions over known values
`when:` accepts a whole-value template for truthiness, or a string that compares one whole-value template
to a quoted string using `==` or `!=`. It applies to every action. A false condition marks the step
skipped, lets execution continue, and does not trigger recovery. The loader rejects shell commands, argv
guards, arbitrary expressions, structured arrays or objects, and references to potentially absent values.
For scalar truthiness, empty string, numeric zero, boolean false, and null count as false. Every other
scalar counts as true. Equality compares the canonical text rendering of the scalar.

#### Scenario: Platform condition
- **WHEN** `when:` is `'{{context.platform}} == "windows"'` on Linux
- **THEN** the step is recorded as skipped and the next step runs

#### Scenario: Arbitrary expression
- **WHEN** `when:` contains shell source or boolean operators
- **THEN** loading fails because v1alpha1 has no general expression language

### Requirement: Tolerated failure
`continue_on_error: true` records an action failure and continues to the next step without invoking
`on_failure`. A spawned local command always exposes its structured result after process exit, so a later
step may reference it even when the exit code is nonzero. The loader rejects references to a
`continue_on_error` agent, Herdr, workflow, placed, readiness, or background action, because those
actions might fail without a natural result. Process spawn and runner infrastructure failures stay hard
failures because they produce no command result. A tolerated failure still makes the complete run fail
and the CLI exit nonzero after remaining steps finish. It differs from a hard failure only by continuing
and suppressing recovery.

#### Scenario: Best-effort cleanup
- **WHEN** a cleanup Herdr action fails with `continue_on_error: true`
- **THEN** later steps run and the run log retains the cleanup failure

#### Scenario: Tolerated command result
- **WHEN** a local command exits nonzero with `continue_on_error: true`
- **THEN** a later step may inspect its `failed`, `exit_code`, `stdout`, and `stderr`

### Requirement: Constrained retries
`retry:` requires a map containing integer `attempts` of at least 2 and optional positive duration
`delay`, using the same positive `<integer><ms|s|m|h>` grammar as `timeout`. Attempts count total
executions, including the first. Retry is allowed only on a blocking local `run` or `herdr` action. Agent,
workflow, placed, readiness, and background actions reject retry. Exhaustion fails the step normally.
V1alpha1 does not support retry predicates, resets, or attempt templates.

#### Scenario: Local command succeeds on retry
- **WHEN** a local command with two attempts fails once and then exits zero
- **THEN** the step succeeds after exactly two executions

#### Scenario: Agent retry
- **WHEN** an agent step declares retry
- **THEN** loading fails rather than risking duplicate or stranded agent panes

### Requirement: Single workflow failure action
Top-level `on_failure:` contains exactly one `agent`, `run`, `herdr`, or `workflow` action. Recovery
rejects `id`, `when`, `continue_on_error`, `background`, and `retry`. Recovery agent actions accept only
`using`, `target`, `cwd`, `env`, `pane`, and `timeout`. Recovery run actions accept only `shell`, `cwd`,
`env`, `pane`, `ready_when`, and `timeout`. Recovery Herdr actions accept only `params`. Recovery workflow
actions accept only `inputs`.

Only the directly invoked entry workflow's failure action runs. Failure actions declared by child or
recovery workflows do not run in that invocation. The active action executes at most once, after the
first non-tolerated runtime failure anywhere in the child stack. Child failures bubble to the entry
action. Cycle checks treat recovery-target workflows the same as ordinary composition cycles.

`context.error` contains required string `message`, required string `workflow`, required string `action`
equal to `agent|run|herdr|workflow`, required integer `step_number`, required string-array
`workflow_path` from entry to the workflow containing the failed action, optional string `step_id`, and
required object `details`. A child failure identifies the child's internal failing action and local step
number, rather than the parent's workflow action. Command details contain available `stdout`, `stderr`,
and `exit_code`. Placed failures also contain available `pane_id`, `tab_id`, and `workspace_id`. Agent
details contain available `profile`, native kind or target, and pane identifiers. Herdr details contain
`method` and reason. Workflow details contain the child workflow name. Recovery failure is final and does
not recurse. Parse, validation, and preflight failures do not invoke recovery. The original workflow stays
failed after recovery succeeds. Step-scoped recovery does not exist.

Any unexpected Herdr transport loss after dispatching an in-flight agent, placed run, or Herdr RPC counts
as uncertain coordination loss, because the protocol does not identify live handoff separately from other
disconnects. The runner stops, preserves created panes, skips recovery, and reports that the underlying
action may still be active. It does not replay, retry, or infer completion.

#### Scenario: Notification recovery
- **WHEN** step two fails and `on_failure` calls `notification.show`
- **THEN** the notification runs once with step-two error context and the workflow remains failed

#### Scenario: Recovery failure
- **WHEN** the failure action also fails
- **THEN** the run reports the original and recovery errors without another recovery attempt

#### Scenario: Child and parent both declare recovery
- **WHEN** a child fails and both child and directly invoked parent declare `on_failure`
- **THEN** only the parent's failure action runs once and the run remains failed

#### Scenario: Only tolerated failures
- **WHEN** every failed step uses `continue_on_error: true`
- **THEN** all later steps run, recovery does not run, and final CLI status is nonzero

#### Scenario: Transport interrupts wait
- **WHEN** the Herdr transport closes while a workflow operation is in flight
- **THEN** the run stops with coordination-interrupted status and does not execute `on_failure`

## REMOVED Requirements

### Requirement: Skip as a third step outcome
**Reason**: Skip remains observable, but skipped outputs no longer bind empty sentinel values.
**Migration**: Do not reference conditionally skipped steps.

### Requirement: Guards via `when:`
**Reason**: Shell and argv guards are replaced by constrained value conditions.
**Migration**: Use truthiness or quoted equality over `inputs`, `steps`, or `context`.

### Requirement: Sequential loops via `for:`
**Reason**: Loops are outside the evidenced linear ritual scope.
**Migration**: Use one explicit step or a purpose-built command; propose loops later with concrete need.

### Requirement: Loop bounds and failure isolation
**Reason**: V1 has no workflow loops.
**Migration**: Handle iteration and aggregation inside a deterministic command when necessary.

### Requirement: Retries via `retry:`
**Reason**: General retries, predicates, resets, and attempt bindings create scheduler complexity.
**Migration**: Use constrained `{attempts, delay}` only on local commands and Herdr actions.

### Requirement: Reset required for pane-creating retries
**Reason**: V1 rejects every pane-creating retry instead of exposing reset machinery.
**Migration**: Remove retry or restructure the step as a local deterministic command.

### Requirement: Tolerated failures via `allow_fail:`
**Reason**: The modifier is renamed for clarity and result semantics changed.
**Migration**: Use `continue_on_error: true`.

### Requirement: Recovery via `on_error:`
**Reason**: Nested lists, workflow names, and step-scoped recovery are replaced by one explicit action.
**Migration**: Use top-level `on_failure:`; move multi-step recovery into one child workflow.
