## MODIFIED Requirements

### Requirement: Single workflow failure action
Top-level `on_failure:` MUST contain exactly one `agent`, `run`, `herdr`, or `workflow` action. Recovery MUST reject `id`, `when`, `continue_on_error`, `background`, and `retry`. Recovery agent actions MUST accept only `using`, `target`, `cwd`, `env`, `pane`, and `timeout`. Recovery run actions MUST accept only `shell`, `cwd`, `env`, `pane`, `ready_when`, and `timeout`. Recovery Herdr actions MUST accept only `params`. Recovery workflow actions MUST accept only `inputs`.

Only the directly invoked entry workflow's failure action MUST run. Failure actions declared by child or recovery workflows MUST NOT run in that invocation. The active action MUST execute at most once, after the first non-tolerated runtime failure anywhere in the child stack. Child failures MUST bubble to the entry action. Cycle checks MUST treat recovery-target workflows the same as ordinary composition cycles.

`context.error` MUST contain required string `message`, required string `workflow`, required string `action` equal to `agent|run|herdr|workflow`, required integer `step_number`, required string-array `workflow_path` from entry to the workflow containing the failed action, optional string `step_id`, and required object `details`. A child failure MUST identify the child's internal failing action and local step number, rather than the parent's workflow action. Command details MUST contain available `stdout`, `stderr`, and `exit_code`. Placed failures MUST also contain available `pane_id`, `tab_id`, and `workspace_id`. Agent details MUST contain available `profile`, native kind or target, and pane identifiers. Herdr details MUST contain `method` and reason. Workflow details MUST contain the child workflow name. Recovery failure MUST be final and MUST NOT recurse. Parse, validation, and preflight failures MUST NOT invoke recovery. The original workflow MUST stay failed after recovery succeeds. Step-scoped recovery MUST NOT exist.

Any unexpected Herdr transport loss after dispatching an in-flight agent, placed run, or Herdr RPC MUST count as uncertain coordination loss, because the protocol does not identify live handoff separately from other disconnects. Transport loss MUST be identified by the socket client's stable error codes, never by matching error message text. The runner MUST stop, preserve created panes, skip recovery, and report that the underlying action may still be active. It MUST NOT replay, retry, or infer completion.

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

#### Scenario: Coordination loss carries a stable code
- **WHEN** the socket client surfaces a transport failure during a dispatched action
- **THEN** the failure carries one of the stable transport-loss error codes (`closed`, `no_socket`, or `unreachable`) and the runner treats it as coordination loss without inspecting message text

#### Scenario: Non-transport HerdrError allows recovery
- **WHEN** the socket client surfaces a non-transport `HerdrError` (for example code `internal`) during a dispatched action
- **THEN** the runner treats it as an ordinary failure and executes `on_failure`
