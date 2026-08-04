## MODIFIED Requirements

### Requirement: Step history records dispatch outcomes
Before dispatch the runner MUST persist the current step. After an outcome it MUST append an ordered record and clear the current step. Outcomes MUST distinguish skipped, succeeded, failed-and-continued, launched, hard failed, and coordination interrupted. A successful outcome whose action result reported omitted older terminal rows MUST persist `truncated: true`, and detail projection MUST present that flag with the step outcome. Recovery MUST be identified by phase. Nested records (workflow path longer than the entry path) MUST carry a positive `parent_ordinal` for the invoking step. Top-level entry records MUST omit `parent_ordinal`. Snapshots that omit or invent that identity for nested records MUST be rejected. Detail projection MUST group nested outcomes only under the matching workflow wrapper via `parent_ordinal` and MUST NOT attach nested outcomes by path alone. The projection MUST NOT invent identities for steps that did not start. it MAY report a known remaining count.

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

#### Scenario: Truncated read is visible in detail
- **WHEN** a `herdr:` read step succeeds with `read.truncated: true`
- **THEN** the persisted step record carries `truncated: true` and detail projection presents the flag with the succeeded outcome
