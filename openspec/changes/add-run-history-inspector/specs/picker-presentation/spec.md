## ADDED Requirements

### Requirement: Tab switches the two root browsers
The picker MUST provide Workflow and Runs root browsers in the existing popup. Tab MUST switch between them whenever either root browser is active, including while its filter has focus. Tab MUST NOT switch during input collection, live launch, run detail, an actions palette, or confirmation. The pane title MUST remain static. The active browser MUST be evident from its filter placeholder and footer without adding a body title row.

#### Scenario: Workflow filter has text
- **WHEN** the Workflow browser filter has focus and the user presses Tab
- **THEN** the Runs browser opens and no tab character enters either filter

#### Scenario: Input collection
- **WHEN** a workflow input prompt is active and the user presses Tab
- **THEN** the picker does not switch to Runs

#### Scenario: Return to workflows
- **WHEN** the Runs root browser is active and the user presses Tab
- **THEN** the Workflow browser returns with the static Herdr pane title unchanged

### Requirement: Runs use the fixed list chrome
The Runs root MUST reuse the fixed six-row viewport, selected-detail area, inset separator, footer, width-derived truncation, and ASCII-only chrome. Each row MUST contain textual status, workflow title or name, available step progress, and elapsed time. All scope MAY add a width-bounded checkout basename when it disambiguates rows. The row MUST NOT depend on color or a status glyph alone.

#### Scenario: More than six runs
- **WHEN** eight runs match the history filter
- **THEN** six single-line rows render and cursor movement scrolls the viewport without moving the detail or footer

#### Scenario: Narrow popup
- **WHEN** status, workflow, progress, elapsed time, and location exceed the rendered width
- **THEN** the workflow or location fields truncate at grapheme boundaries while status and footer remain legible

#### Scenario: Interrupted run
- **WHEN** an interrupted run appears
- **THEN** its row contains the text `INTERRUPTED` or a width-bounded textual abbreviation in addition to any color

### Requirement: Run filtering and scope are keyboard safe
The Runs filter MUST match case-insensitively against workflow title and name, run ID, status, safe step labels, and allowlisted failure facts. It MUST NOT match private failure explanation text. Runs MUST default to the exact current checkout root. `Ctrl+G` MUST toggle Current and All without entering filter text. The stdin pre-handler MUST preserve raw `0x07` for OpenTUI. The active scope MUST be visible without consuming a list row. Printable `g` MUST remain filter text.

#### Scenario: Toggle all worktrees
- **WHEN** the Runs root is scoped to Current and the user presses `Ctrl+G`
- **THEN** matching retained runs from all checkout roots become eligible and the scope indicator changes to All

#### Scenario: Printable scope letter
- **WHEN** the Runs filter has focus and the user types `g` without Control
- **THEN** `g` enters the filter and the scope does not change

#### Scenario: Search a short displayed ID
- **WHEN** the user enters a visible run ID prefix in the Runs filter
- **THEN** matching rows remain selectable even though detail lookup uses the complete UUID

### Requirement: Every selected run has a compact detail view
Enter on any durable run row MUST replace the list with a scrollable ordered step view. Running detail MUST identify the persisted active step, heartbeat-defined state, and elapsed time. Successful detail MUST show every recorded completed or skipped step. Failed detail MUST show recorded outcomes, a known remaining count, and the bounded failure explanation. It MUST NOT invent names for steps that did not start. Nested workflow outcomes MUST remain grouped under one parent wrapper. Interrupted, stale, and unavailable-history detail MUST state their distinct condition. `w` MUST hand the complete run UUID to the authenticated workbench route. Escape MUST return to the Runs root without dismissing the picker.

#### Scenario: Inspect a successful run
- **WHEN** the user presses Enter on a successful four-step run
- **THEN** detail shows all four outcomes and offers `w` for the workbench

#### Scenario: Inspect an active run
- **WHEN** the user presses Enter on a running run
- **THEN** detail marks the persisted active step running, updates elapsed time from the run start, and does not infer process ownership beyond heartbeat freshness

#### Scenario: Inspect a tolerated failure
- **WHEN** a run continued after one tolerated failure
- **THEN** detail shows that failure as continued, shows later executed steps, and keeps the final run failed

#### Scenario: Return from detail
- **WHEN** run detail is active and the user presses Escape
- **THEN** the prior Runs selection and filter return

#### Scenario: Workbench handoff fails
- **WHEN** `w` cannot launch the authenticated workbench route
- **THEN** detail remains open and reports a width-bounded handoff error

### Requirement: Run-history empty states identify the remedy
The picker MUST distinguish no machine history, no runs in Current, and no filter matches. When Current is empty but All has runs, the empty state MUST identify `Ctrl+G` as the way to view them. A filter miss MUST keep the filter visible. No empty state MUST claim that a stale run failed.

#### Scenario: No current runs
- **WHEN** the machine has retained runs but none match the current checkout root
- **THEN** the Runs browser reports no runs in this worktree and identifies `Ctrl+G` for All

#### Scenario: No machine runs
- **WHEN** no retained run exists
- **THEN** the Runs browser reports that no workflow has run yet

#### Scenario: Filter miss
- **WHEN** retained runs exist in the active scope but none match the filter
- **THEN** the filter remains visible and the detail area reports no matching runs

### Requirement: A launched workflow opens matching run detail
After the final input is accepted, the picker MUST allocate a full run UUID, launch the child with that private identity, and immediately open matching local detail in `STARTING` state. The child MUST exclusively claim that snapshot identity and send one machine-readable acknowledgement through the observed launch channel. A successful claim MUST move detail to attached `RUNNING`; unavailable storage MUST move it to `RUNNING · HISTORY UNAVAILABLE`; a rejected claim or spawn failure MUST remain a picker-local launch failure. Success, failure, and interruption MUST remain visible until the user leaves detail and MUST NOT auto-dismiss the picker.

#### Scenario: Child acknowledges start
- **WHEN** the picker spawns a workflow child and receives its successful snapshot-claim acknowledgement
- **THEN** the open detail changes from starting to running for that exact UUID

#### Scenario: Child cannot record history
- **WHEN** the child acknowledges that private history storage is unavailable
- **THEN** the open detail identifies unavailable history, continues attached progress observation, does not claim a durable record, and does not offer a workbench deep link for that identity

#### Scenario: Child fails before claim
- **WHEN** the detached child exits without acknowledging a matching snapshot claim
- **THEN** the open detail reports a local launch failure and does not present it as durable history

#### Scenario: Fast successful workflow
- **WHEN** a launched workflow succeeds before the user leaves detail
- **THEN** the detail changes to succeeded, shows every step outcome and elapsed time, and stays open

#### Scenario: Leave an active launch
- **WHEN** a directly launched run is still active and the user presses Escape
- **THEN** the picker detaches direct child observation, returns to the Runs root, and the workflow continues

## MODIFIED Requirements

### Requirement: Input navigation preserves valid answers
Escape from an input prompt MUST move to the previous active input and restore its collected value. Escape from the first active input MUST return to the workflow list. Changing an earlier value MUST discard all later answers and resolved dynamic-choice domains before active inputs are recalculated. Returning to the list MUST clear the collection. A terminal run result MUST remain in run detail until the user presses Escape, which MUST return to the Runs root without dismissing the picker.

#### Scenario: Correct the final answer
- **WHEN** a user presses Escape on the last of three active inputs
- **THEN** the picker returns to the second input and preserves the first input's answer

#### Scenario: Mode change alters active inputs
- **WHEN** a user navigates back, changes `mode` from `create` to `delete`, and continues
- **THEN** later create-only answers are discarded and only delete-active inputs are collected

#### Scenario: Failed run navigation
- **WHEN** a launched run has failed and the user presses Escape
- **THEN** the picker returns to the Runs root with the failed run selected
