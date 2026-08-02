# run-history Specification

## Purpose
Durable private per-run snapshot history: exclusive run identity, atomic recoverable snapshots, heartbeat-based liveness, exact-checkout scoping, bounded retention, and privacy-preserving list/detail projection.

## Requirements

### Requirement: Runs have durable exclusive identity
After an entry workflow loads, the runner MUST use a complete canonical UUID and exclusively create one versioned snapshot for that run. The snapshot MUST identify the entry workflow, its source, the exact canonical checkout root, start time, heartbeat time, current step, ordered recorded outcomes, private returns, and optional terminal state. A picker-supplied UUID MUST arrive through the private launch payload and MUST fail before execution if its snapshot is already claimed.

#### Scenario: Concurrent runs of one workflow
- **WHEN** two processes run the same workflow from the same checkout
- **THEN** each exclusively owns a different snapshot and neither process can replace the other's state

#### Scenario: Reused supplied identity
- **WHEN** a launch payload supplies a valid UUID whose snapshot already exists
- **THEN** the child rejects the launch before executing a workflow step

### Requirement: Snapshot replacement is recoverable and optional
The writer MUST maintain complete run state in memory and replace the snapshot through a same-directory temporary file and atomic rename. A failed history initialization or replacement MUST NOT fail or alter workflow execution. A later successful replacement MUST contain the complete latest state rather than depend on the failed write.

#### Scenario: Intermediate replacement fails
- **WHEN** one snapshot replacement fails and the next replacement succeeds
- **THEN** the readable snapshot contains the complete current run state

#### Scenario: History location is unavailable
- **WHEN** private run storage cannot be created or validated
- **THEN** the workflow continues and the caller can distinguish unavailable history from durable history

### Requirement: Live state uses heartbeat freshness
A non-terminal snapshot MUST project as active while its heartbeat is less than fifteen seconds old and stale afterward. A terminal status MUST take precedence over heartbeat age. Stale MUST remain non-terminal and MUST return to active after a fresh heartbeat. Interrupted MUST identify only an explicitly recorded terminal coordination loss.

#### Scenario: Writer stops refreshing
- **WHEN** a non-terminal snapshot receives no heartbeat for fifteen seconds
- **THEN** it projects as stale without projecting failure

#### Scenario: Terminal run ages
- **WHEN** a succeeded or failed snapshot becomes older than fifteen seconds
- **THEN** it retains its terminal status

#### Scenario: Stale writer resumes
- **WHEN** a stale snapshot receives a fresh heartbeat
- **THEN** it projects as active again

### Requirement: Current scope is one exact checkout
Current scope MUST include only snapshots whose canonical checkout root equals the active workbench or picker checkout root. It MUST exclude sibling worktrees, other clones, and repository-family matches. All scope MAY include retained records from every checkout and MUST be an explicit temporary selection.

#### Scenario: Sibling worktree has runs
- **WHEN** two worktrees share Git history but have different canonical roots
- **THEN** Current in either worktree includes only its exact-root runs

#### Scenario: Return to the workbench
- **WHEN** a user reloads the workbench after selecting All
- **THEN** Location returns to the current checkout

### Requirement: Step history records dispatch outcomes
Before dispatch the runner MUST persist the current step. After an outcome it MUST append an ordered record and clear the current step. Outcomes MUST distinguish skipped, succeeded, failed-and-continued, launched, hard failed, and coordination interrupted. Recovery MUST be identified by phase. Nested records (workflow path longer than the entry path) MUST carry a positive `parent_ordinal` for the invoking step. Top-level entry records MUST omit `parent_ordinal`. Snapshots that omit or invent that identity for nested records MUST be rejected. Detail projection MUST group nested outcomes only under the matching workflow wrapper via `parent_ordinal` and MUST NOT attach nested outcomes by path alone. The projection MUST NOT invent identities for steps that did not start. it MAY report a known remaining count.

#### Scenario: Failure continues
- **WHEN** a step fails under continue behavior and later steps execute
- **THEN** history retains the tolerated failure and every later recorded outcome

#### Scenario: Hard failure stops entry execution
- **WHEN** a step fails under stop behavior with three known entry steps remaining
- **THEN** detail shows the recorded failure and reports three remaining steps without fabricated names

#### Scenario: Recovery fails
- **WHEN** entry recovery runs and fails
- **THEN** its outcome is recorded once with recovery phase and the run finishes failed

#### Scenario: Nested workflow fails
- **WHEN** a child workflow step fails after an ordinary preceding entry step
- **THEN** detail projection orders that preceding step, then the workflow wrapper, then nested child outcomes, and presents one failure explanation

#### Scenario: Sequential workflow wrappers share a parent path
- **WHEN** an entry runs two sequential `workflow:` steps that each invoke a child
- **THEN** detail projection orders `wrap1`, that child's outcomes, `wrap2`, then the second child's outcomes, using each child's `parent_ordinal`

#### Scenario: Nested record omits parent identity
- **WHEN** a snapshot stores a nested step without a positive `parent_ordinal`
- **THEN** the snapshot is rejected as malformed and is not listed or projected

### Requirement: Claim identity uses a resolvable checkout root
A durable claim MUST store a realpath-canonical checkout root. When the checkout path cannot be resolved at claim time, history MUST be unavailable for that run rather than storing a non-canonical path. List and detail MAY keep soft-canonical lookup so a deleted checkout's retained snapshot remains inspectable under All.

#### Scenario: Claim resolves through a symlink
- **WHEN** the runner claims history with a symlink checkout path
- **THEN** the snapshot stores the realpath-canonical root

#### Scenario: Claim path cannot be resolved
- **WHEN** the checkout path does not exist at claim time
- **THEN** history is unavailable for that run and execution continues

#### Scenario: Deleted checkout remains listable
- **WHEN** a retained snapshot's checkout directory has been removed
- **THEN** All-scope soft-canonical lookup still surfaces that snapshot

### Requirement: Failure projections separate list facts from detail explanation
List data MUST contain only allowlisted scalar facts and safe labels. It MUST exclude prompts, inputs, environment values, params, transcripts, returns, pane content, raw captures, and failure explanation text. A selected-run detail MAY include the runner's bounded failure explanation through an authenticated detail response. Search MUST NOT index that explanation.

#### Scenario: List a failed command
- **WHEN** a command failure includes captured output
- **THEN** the list projection exposes its action kind and exit code but no output or failure explanation

#### Scenario: Inspect a failed command
- **WHEN** an authenticated client requests that selected run's detail
- **THEN** the response may include the bounded persisted explanation but no separate stdout or stderr body

#### Scenario: Search secret-shaped explanation text
- **WHEN** a failure explanation contains text that matches a search query
- **THEN** that text does not make the run match

### Requirement: Run storage and responses remain private
The run-history directory and files MUST pass the existing private credential-store ownership and permission assertions. Authenticated workbench page, list, and detail responses MUST include `Cache-Control: no-store`, matching the workbench rule that authenticated JSON is not stored by caches. A permission mismatch MUST make history unavailable rather than weaken access checks. When the state root or runs directory is a directory with permissive mode but no entries, the runner MUST tighten it to private (0700) and proceed. A non-empty permissive state root or runs directory MUST make history unavailable.

#### Scenario: Run directory is group-readable
- **WHEN** a non-empty run-history state root has unsafe permissions
- **THEN** history is unavailable and the runner does not change the permissions silently

#### Scenario: Empty permissive state root
- **WHEN** the state root exists with permissive mode and contains no entries
- **THEN** the runner tightens it to private mode and history remains available

### Requirement: Recent history is bounded after filtering
History projection MUST apply scope, status, and text predicates before sorting newest first and returning at most forty runs. Terminal snapshots MUST share a fixed 512,000-byte retention target. Cleanup MUST run only on creation and terminal persistence, delete oldest terminal snapshots first, and never delete an active or stale non-terminal snapshot.

#### Scenario: Current run lies below foreign runs
- **WHEN** forty newer foreign-checkout runs precede a current-checkout run
- **THEN** Current can still return that run because scope is applied before the limit

#### Scenario: Cleanup sees active and terminal snapshots
- **WHEN** retention exceeds its target while active and old terminal snapshots exist
- **THEN** cleanup removes oldest terminal snapshots and preserves every non-terminal snapshot

#### Scenario: Newest record exceeds the target
- **WHEN** the newest terminal snapshot alone exceeds the byte target
- **THEN** it remains readable until a later terminal snapshot makes it eligible for oldest-first removal

### Requirement: Prior shared log is ignored
New runs MUST NOT write, read, migrate, or delete a prior shared `runs.jsonl`. History list and detail MUST use only retained per-run snapshots. An existing `runs.jsonl` on disk MUST NOT appear in Current or All.

#### Scenario: Shared log file remains on disk
- **WHEN** a prior `runs.jsonl` exists under plugin state
- **THEN** list and detail omit every row from that file and leave the file unchanged
