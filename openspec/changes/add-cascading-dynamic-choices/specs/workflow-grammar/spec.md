# workflow-grammar Delta

## MODIFIED Requirements

### Requirement: Named adaptive inputs
Input names MUST match `[a-z][a-z0-9_]{0,31}`. Values MUST be `text`, `profile`, a non-empty static choice list, or a strict map containing only `type`, `description`, `default`, `when`, `allow_custom`, `min_length`, and, conditionally, `options`. Map type MUST be `text`, `choice`, or `profile`. Choice MUST require static options or `{run: <argv>}`. Text and profile MUST reject options. Dynamic choice failure or empty output MUST fail collection. Choice and profile defaults MUST exist in the available values. Only the entry workflow MUST prompt, in declaration order, and unused inputs MUST fail load.

Dynamic choice argv elements MAY contain templates rooted at `inputs` that reference earlier declared inputs. Templates rooted at `steps` or `context` inside dynamic argv MUST be load errors. A self reference or forward reference MUST be a load error. Referencing a conditional input MUST be a load error unless the consuming input's `when:` carries every clause that guards the referenced input. The runner MUST substitute referenced values into argv elements before execution. Dynamic choice argv MUST run from repository root with the invoking environment and MUST receive no partially collected input exports. Nonzero exit MUST fail the step with capped stderr. Stdout MUST split on LF/CRLF, trim surrounding whitespace, discard empty lines, and deduplicate while preserving first-seen order. More than 1,000 choices, or crossing the shared capture cap, MUST fail input collection. Dynamic choice commands MUST time out after 10 seconds and get terminated as a process group.

#### Scenario: Profile picker
- **WHEN** an input has type profile
- **THEN** the picker lists merged native-kind profile names in deterministic order

#### Scenario: Cascading dynamic choice
- **WHEN** input `repo` is a dynamic choice and input `branch` declares `{run: [git, -C, "{{inputs.repo}}", branch, --format, "%(refname:short)"]}`
- **THEN** the `branch` options resolve after `repo` is answered, with the answered value substituted into the argv element

#### Scenario: Forward reference in dynamic argv
- **WHEN** an earlier input's dynamic argv references a later input
- **THEN** loading fails naming the forward reference

#### Scenario: Unguarded reference to a conditional input
- **WHEN** input `branch` references `{{inputs.remote}}` in its dynamic argv, `remote` is guarded by `mode == "push"`, and `branch` declares no matching guard
- **THEN** loading fails naming the missing guard clause

### Requirement: Entry dynamic choices resolve once
Workflow loading and listing MUST validate dynamic-choice declarations without executing them. Entry input collection MUST execute only active dynamic choices, at most once per invocation, except that a choice whose resolved domain is discarded because an earlier answer changed MUST resolve again from the new answer. A detached picker run MUST reuse the option domains collected by its parent and MUST NOT execute those commands again. The detached runner MUST reject snapshots for undeclared, inactive, static, text, or profile inputs. Direct CLI and child invocation MUST each resolve their own active dynamic options once. Dynamic-choice argv MUST accept `inputs`-rooted templates only and MUST receive no partially collected input exports.

#### Scenario: Picker launches dynamic choice workflow
- **WHEN** the picker resolves one active dynamic choice and starts its detached run
- **THEN** the discovery command executes exactly once and the child validates against the same option snapshot

#### Scenario: Inactive dynamic choice
- **WHEN** a dynamic choice input has a false input condition
- **THEN** its command does not execute

#### Scenario: Dependent domain after an earlier answer changes
- **WHEN** a user navigates back and gives input `repo` a different value
- **THEN** the domain of the dependent choice is discarded and its command runs again with the new value
