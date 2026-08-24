# scratchspace Specification

## Purpose
TBD - created by archiving change sqlite-storage. Update Purpose after archive.
## Requirements
### Requirement: Scratch is a flat key-value table

Scratch MUST live in the same global `history.db` as run history. The table MUST be `key`, `value`, and `updated_at` only. The key MUST be the entire identifier. There MUST NOT be scope columns, hierarchy, or a permission model. Values MUST apply the existing 8 MiB capture cap at write and MUST NOT truncate. There MUST NOT be a `{{scratch.*}}` template root. A step that needs a scratch value MUST run `hwf scratch get` (or equivalent) as a command and consume `{{steps.*.stdout}}`.

#### Scenario: Set then get

- **WHEN** the user sets key `triage.last_pr` to `42` and then gets that key
- **THEN** stdout is `42`

#### Scenario: List is flat

- **WHEN** keys `a` and `run-id.b` exist
- **THEN** `list` prints both keys and does not group them

#### Scenario: Over-cap write fails

- **WHEN** a set value exceeds the 8 MiB capture cap
- **THEN** the write fails naming source and limit and the previous value is unchanged

#### Scenario: Template root is rejected

- **WHEN** a workflow contains `{{scratch.x}}`
- **THEN** load fails as an unknown template root

### Requirement: Run-prefixed keys expire with the run

When retention expires a run, scratch MUST delete keys that match `<run-id>.*`. Keys without that prefix MUST remain until deleted. The engine MUST inject `HWF_RUN_ID`, `HWF_WORKFLOW`, and `HWF_CHECKOUT_ROOT` into every pane it launches and into local `run:` environments.

#### Scenario: Prefixed keys die with the run

- **WHEN** a run expires and scratch holds `RUNID.findings.1` and `shared.note`
- **THEN** only `RUNID.findings.1` is deleted

#### Scenario: Launched pane sees run identity

- **WHEN** the engine launches a pane for a claimed run
- **THEN** that pane's environment includes `HWF_RUN_ID` equal to the run id, `HWF_WORKFLOW` equal to the workflow name, and `HWF_CHECKOUT_ROOT` equal to the checkout root

