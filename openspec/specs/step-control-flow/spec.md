# step-control-flow Specification

## Purpose
Linear step execution with constrained conditions, retries, tolerated failure, and a single entry-workflow `on_failure` action.

## Requirements
### Requirement: Strictly linear workflow execution
The runner MUST process steps in document order. It MUST NOT support loops, parallel groups, joins, dependencies, or scheduler queues. A background action MUST represent a launched process, not a branch. The runner MUST never join a background action for a result.

#### Scenario: Ordered actions
- **WHEN** a workflow contains three blocking steps
- **THEN** each step starts only after its predecessor finishes successfully or has a tolerated failure

### Requirement: Conditions over known values
`when:` MUST accept a whole-value template for truthiness, or a string that compares one whole-value template to a quoted string using `==` or `!=`. It MUST apply to every action. A false condition MUST mark the step skipped, let execution continue, and MUST NOT trigger recovery. The loader MUST reject shell commands, argv guards, arbitrary expressions, structured arrays or objects, and references to potentially absent values. For scalar truthiness, empty string, numeric zero, boolean false, and null MUST count as false. Every other scalar MUST count as true. Equality MUST compare the canonical text rendering of the scalar.

#### Scenario: Platform condition
- **WHEN** `when:` is `'{{context.platform}} == "windows"'` on Linux
- **THEN** the step is recorded as skipped and the next step runs

#### Scenario: Arbitrary expression
- **WHEN** `when:` contains shell source or boolean operators
- **THEN** loading fails because v1alpha1 has no general expression language

### Requirement: Tolerated failure
`continue_on_error: true` MUST record an action failure and continue to the next step without invoking `on_failure`. A spawned local command MUST always expose its structured result after process exit, so a later step may reference it even when the exit code is nonzero. The loader MUST reject references to a `continue_on_error` agent, Herdr, workflow, placed, readiness, or background action, because those actions might fail without a natural result. Process spawn and runner infrastructure failures MUST stay hard failures because they produce no command result. A tolerated failure MUST still make the complete run fail and the CLI exit nonzero after remaining steps finish. It MUST differ from a hard failure only by continuing and suppressing recovery.

#### Scenario: Best-effort cleanup
- **WHEN** a cleanup Herdr action fails with `continue_on_error: true`
- **THEN** later steps run and the run log retains the cleanup failure

#### Scenario: Tolerated command result
- **WHEN** a local command exits nonzero with `continue_on_error: true`
- **THEN** a later step may inspect its `failed`, `exit_code`, `stdout`, and `stderr`

### Requirement: Constrained retries
`retry:` MUST require a map containing integer `attempts` of at least 2 and optional positive duration `delay`, using the same positive `<integer><ms|s|m|h>` grammar as `timeout`. Attempts MUST count total executions, including the first. Retry MUST be allowed only on a blocking local `run` or `herdr` action. Agent, workflow, placed, readiness, and background actions MUST reject retry. Exhaustion MUST fail the step normally. V1alpha1 MUST NOT support retry predicates, resets, or attempt templates.

#### Scenario: Local command succeeds on retry
- **WHEN** a local command with two attempts fails once and then exits zero
- **THEN** the step succeeds after exactly two executions

#### Scenario: Agent retry
- **WHEN** an agent step declares retry
- **THEN** loading fails rather than risking duplicate or stranded agent panes

### Requirement: Single workflow failure action
Top-level `on_failure:` MUST contain exactly one `agent`, `run`, `herdr`, or `workflow` action. Recovery MUST reject `id`, `when`, `continue_on_error`, `background`, and `retry`. Recovery agent actions MUST accept only `using`, `target`, `cwd`, `env`, `pane`, and `timeout`. Recovery run actions MUST accept only `shell`, `cwd`, `env`, `pane`, `ready_when`, and `timeout`. Recovery Herdr actions MUST accept only `params`. Recovery workflow actions MUST accept only `inputs`.

Only the directly invoked entry workflow's failure action MUST run. Failure actions declared by child or recovery workflows MUST NOT run in that invocation. The active action MUST execute at most once, after the first non-tolerated runtime failure anywhere in the child stack. Child failures MUST bubble to the entry action. Cycle checks MUST treat recovery-target workflows the same as ordinary composition cycles.

`context.error` MUST contain required string `message`, required string `workflow`, required string `action` equal to `agent|run|herdr|workflow`, required integer `step_number`, required string-array `workflow_path` from entry to the workflow containing the failed action, optional string `step_id`, and required object `details`. A child failure MUST identify the child's internal failing action and local step number, rather than the parent's workflow action. Command details MUST contain available `stdout`, `stderr`, and `exit_code`. Placed failures MUST also contain available `pane_id`, `tab_id`, and `workspace_id`. Agent details MUST contain available `profile`, native kind or target, and pane identifiers. Herdr details MUST contain `method` and reason. Workflow details MUST contain the child workflow name. Recovery failure MUST be final and MUST NOT recurse. Parse, validation, and preflight failures MUST NOT invoke recovery. The original workflow MUST stay failed after recovery succeeds. Step-scoped recovery MUST NOT exist.

Any unexpected Herdr transport loss after dispatching an in-flight agent, placed run, or Herdr RPC MUST count as uncertain coordination loss, because the protocol does not identify live handoff separately from other disconnects. The runner MUST stop, preserve created panes, skip recovery, and report that the underlying action may still be active. It MUST NOT replay, retry, or infer completion.

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
