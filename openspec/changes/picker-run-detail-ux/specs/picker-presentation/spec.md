# picker-presentation — delta

## ADDED Requirements

### Requirement: Failed run detail offers send-back to an agent
On the failed-run detail, `s` MUST assemble a send-back bundle from the focused failed step and type it into a target agent pane input without submitting it. The bundle MUST reuse the console annotation bundle and MUST add a `--- failure ---` block carrying the run, checkout, step, cause, exit code, and step source. The bundle MUST NOT include the captured output tail. When more than one agent pane exists, the picker MUST show a chooser before typing. Bundles larger than the agent prompt cap MUST spill to a private file and type the spill instruction instead. The host call MUST use `pane.send_text`.

#### Scenario: Send back the failed step
- **WHEN** the user focuses a failed step and presses `s` with one agent pane available
- **THEN** that pane receives a bundle with a `--- failure ---` block naming the cause and step source

#### Scenario: Choose an agent pane
- **WHEN** the user confirms send-back and two agent panes are available
- **THEN** the picker shows a chooser and types into the pane the user selects

## MODIFIED Requirements

### Requirement: Every selected run has a compact detail view
Enter on any durable run row MUST replace the list with a card-rail detail view reusing the console diagram layout: a rail of step cards and a detail pane for the focused step. The Runs list MUST stay on the compact popup. Opening that detail from the compact popup MUST respawn at `85%` by `80%`, the console size, carrying the selected run id and a detail marker. The restored process MUST open that run's detail and MUST NOT respawn again for that size. Running detail MUST identify the persisted active step, heartbeat-defined state, and elapsed time. Successful detail MUST show every recorded completed or skipped step. Failed detail MUST show recorded outcomes, a known remaining count, and for the focused step a detail pane naming the cause, the command and exit code, a bounded output tail, and the step source. It MUST NOT invent names for steps that did not start. Nested workflow outcomes MUST remain grouped under one parent wrapper. Interrupted, stale, and unavailable-history detail MUST state their distinct condition. Escape MUST return to the Runs list. When the popup is at the console size for that detail, Escape MUST respawn the compact Runs list without dismissing the picker.

#### Scenario: Inspect a successful run
- **WHEN** the user presses Enter on a successful four-step run
- **THEN** detail shows all four outcome cards

#### Scenario: Inspect an active run
- **WHEN** the user presses Enter on a running run
- **THEN** detail marks the persisted active step running, updates elapsed time from the run start, and does not infer process ownership beyond heartbeat freshness

#### Scenario: Inspect a failed run
- **WHEN** the user presses Enter on a failed run and focuses the failed step
- **THEN** the detail pane shows the cause, the command and exit code, a bounded output tail, and the step source

#### Scenario: Inspect a tolerated failure
- **WHEN** a run continued after one tolerated failure
- **THEN** detail shows that failure as continued, shows later executed steps, and keeps the final run failed

#### Scenario: Return from detail
- **WHEN** run detail is active and the user presses Escape
- **THEN** the prior Runs selection and filter return

#### Scenario: Run detail expands the popup
- **WHEN** the Runs list is on the compact popup and the user presses Enter on a run
- **THEN** the picker respawns at `85%` by `80%` and the new process opens that run's detail

#### Scenario: Leave run detail respawns compact
- **WHEN** run detail is open at the console size and the user presses Escape
- **THEN** the picker respawns the compact Runs list with that run selected
