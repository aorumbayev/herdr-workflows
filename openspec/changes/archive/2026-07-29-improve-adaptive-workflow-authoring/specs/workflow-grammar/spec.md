## ADDED Requirements

### Requirement: Guarded sequential input collection
Mapped inputs MAY declare `when:` as one existing condition clause or a non-empty ordered list of clauses. Input conditions MUST reference only earlier inputs, MUST use short-circuit AND semantics, and MUST reject structured values. An inactive input MUST NOT prompt, resolve dynamic options, apply its default, enter the input namespace, or become an automatic `HWF_` environment value. Supplying an inactive entry or child input MUST fail collection. A conditional input reference MUST be a load error unless the consuming site is guarded by every clause that guards the input.

#### Scenario: Mode-specific entry inputs
- **WHEN** `mode` is `delete`, `branch` is guarded by `mode == "create"`, and `worktree` is guarded by `mode != "create"`
- **THEN** the entry picker asks for `worktree` but does not ask for or resolve `branch`

#### Scenario: Forward input dependency
- **WHEN** an input condition references an input declared after it
- **THEN** loading fails at that input condition with a forward-reference error

#### Scenario: Unguarded conditional input use
- **WHEN** a step references a conditional input without including all of that input's guard clauses
- **THEN** loading fails because the input is not proven available

### Requirement: Explicit custom choices and text length
A mapped choice input MAY declare `allow_custom: true`, in which case its options MUST be suggestions and entry or child values outside those options MUST be accepted as text. Omitting `allow_custom` MUST preserve closed choice membership. A mapped input MAY declare non-negative integer `min_length`; every active supplied or default value MUST contain at least that many characters. `allow_custom` MUST be invalid on text and profile inputs.

#### Scenario: Existing or new branch
- **WHEN** a choice offers existing branches with `allow_custom: true`
- **THEN** the picker accepts either a listed branch or newly typed non-empty branch

#### Scenario: Closed choice remains closed
- **WHEN** a choice omits `allow_custom` and receives a value outside its options
- **THEN** collection fails with the available values

#### Scenario: Empty required branch
- **WHEN** an active input declares `min_length: 1` and receives an empty value
- **THEN** collection fails before workflow step 1 and names the input and minimum length

### Requirement: Entry dynamic choices resolve once
Workflow loading and listing MUST validate dynamic-choice declarations without executing them. Entry input collection MUST execute only active dynamic choices, at most once per invocation. A detached picker run MUST reuse the option domains collected by its parent and MUST NOT execute those commands again. The detached runner MUST reject snapshots for undeclared, inactive, static, text, or profile inputs. Direct CLI and child invocation MUST each resolve their own active dynamic options once. Dynamic-choice argv MUST remain template-free and receive no partially collected input exports.

#### Scenario: Picker launches dynamic choice workflow
- **WHEN** the picker resolves one active dynamic choice and starts its detached run
- **THEN** the discovery command executes exactly once and the child validates against the same option snapshot

#### Scenario: Inactive dynamic choice
- **WHEN** a dynamic choice input has a false input condition
- **THEN** its command does not execute

### Requirement: Statically selected pane placement
`pane.open` MAY be a whole-value template that references one unconditional, closed, static choice input. Every option of that input MUST be `tab`, `beside`, or `below`. Literal placement MUST retain its current behavior. Embedded templates and references to text, profile, custom, dynamic, conditional, step-result, or context values MUST be load errors at `pane.open`.

#### Scenario: Placement input
- **WHEN** `place` is the static choice `[tab, beside, below]` and `pane.open` is `{{inputs.place}}`
- **THEN** loading succeeds and the selected literal placement is used before pane creation

#### Scenario: Unbounded placement source
- **WHEN** `pane.open` references a text or custom-choice input
- **THEN** loading fails because the complete placement domain is not statically valid

### Requirement: Accepted local command exit codes
A blocking local `run` MAY declare `success_codes` as a non-empty list of unique integers. Omitting it MUST mean only exit code zero succeeds. A completed command MUST succeed exactly when it did not time out and its exit code is listed. Its natural result MUST retain stdout, stderr, exit code, and `failed`, where `failed` reports whether the command met this success rule. Spawn failure, timeout, and capture overflow MUST remain hard failures. Placed and background runs MUST reject `success_codes`.

#### Scenario: Optional capability probe
- **WHEN** a local probe exits one and declares `success_codes: [0, 1]`
- **THEN** the step succeeds, exposes `exit_code: 1`, and later conditions can skip the optional action

#### Scenario: Unexpected probe failure
- **WHEN** the same probe exits two
- **THEN** the workflow stops normally with the command's failure reason
