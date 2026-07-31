## ADDED Requirements

### Requirement: Runs use a searchable split inspector
The Runs tab MUST provide a labeled native Location selection, one labeled Search input, a newest-first run list, and a selected-run inspector. Search MUST compose with Location and match case-insensitively against workflow identity, complete or displayed run ID, textual status, safe step labels, and allowlisted failure facts. It MUST NOT match private failure explanation text.

#### Scenario: Search by displayed identifier
- **WHEN** the user enters the visible prefix of a run UUID
- **THEN** the matching run remains selectable and detail lookup uses its complete UUID

#### Scenario: Search by status and workflow
- **WHEN** the user enters text present in a run's textual status or workflow identity
- **THEN** the list contains that run when it also matches Location

### Requirement: Location is explicit and temporary
Location MUST default to the exact current checkout root. It MUST offer All folders and canonical roots present in retained snapshots. All MUST include other worktrees without grouping them as one repository family. Location MUST reset to the current checkout on cold load unless a valid run deep link selects a retained foreign record.

#### Scenario: Select a sibling worktree
- **WHEN** the user selects a sibling worktree root
- **THEN** only runs recorded with that exact canonical root remain eligible

#### Scenario: Reload after All
- **WHEN** the user reloads after selecting All folders
- **THEN** Location returns to the current checkout

### Requirement: Run detail presents recorded evidence
The inspector MUST show run identity, exact checkout root, timing, textual status, ordered recorded outcomes, the current active step when present, known remaining counts, and the selected failure's bounded explanation when available. Nested workflow outcomes MUST remain visibly grouped under one parent wrapper. It MUST distinguish skipped, failed-and-continued, launched, failed, interrupted, active, and stale states without relying on color alone. It MUST NOT fabricate labels for steps that did not start.

#### Scenario: Failed run has remaining steps
- **WHEN** a hard failure leaves two known steps unstarted
- **THEN** detail shows the recorded failure and `2 steps not run` without invented step names

#### Scenario: Stale run
- **WHEN** a non-terminal snapshot has an expired heartbeat
- **THEN** detail identifies stale writer activity and does not claim failure

### Requirement: Live refresh preserves interaction
Runs MUST poll only while the Runs tab is active and the document is visible. Each request MUST be aborted or generation-checked so a late response cannot replace another tab or a newer response. Refresh MUST preserve a still-present selection, list position, inspector scroll position, and focused control. It MUST announce only the selected run's transition to a terminal state through an existing polite live region.

#### Scenario: Navigate away during a request
- **WHEN** the user opens another tab before an in-flight Runs request completes
- **THEN** its late response does not replace the active tab content

#### Scenario: Selected run completes
- **WHEN** the selected active run becomes terminal during refresh
- **THEN** detail updates in place, focus stays stable, and one concise terminal transition is announced

#### Scenario: Unselected run changes
- **WHEN** another visible run changes status
- **THEN** its row updates without a live-region announcement

### Requirement: Run deep links select exact retained records
An authenticated `run=<uuid>` route MUST select that complete UUID even when it lies outside the cold Current default. Reload MUST preserve the route selection. Malformed, missing, and evicted UUIDs MUST produce distinct states with a Back to runs action. A displayed UUID prefix MUST never be accepted as route identity.

#### Scenario: Open a foreign retained run
- **WHEN** a valid route names a retained run from another checkout
- **THEN** Runs opens with that exact record selected and Location reflects its root

#### Scenario: Retained run was evicted
- **WHEN** a previously valid deep link names a run no longer retained
- **THEN** the inspector identifies that the record expired and offers Back to runs

#### Scenario: Malformed identifier
- **WHEN** a route contains a malformed or short UUID
- **THEN** the inspector identifies an invalid run link without prefix matching

### Requirement: Workflow editing authority stays checkout-local
Open current workflow MUST appear only when the selected run's checkout root equals the workbench root, its recorded source is editable there, and the current catalog resolves that workflow. Foreign and deleted checkout runs MUST remain inspectable without an edit action.

#### Scenario: Inspect foreign global workflow
- **WHEN** a foreign run records a globally sourced workflow
- **THEN** detail does not offer Open current workflow from the active repository workbench

### Requirement: Runs remains usable at narrow widths
At widths where the split layout cannot preserve both panes, Runs MUST show one pane at a time. A bare Runs route MUST open the list first. A valid run deep link MUST open detail first with Back to runs. All controls, rows, and detail content MUST remain keyboard reachable with visible focus.

#### Scenario: Narrow deep link
- **WHEN** the workbench opens a valid run deep link at narrow width
- **THEN** detail is shown first and Back to runs reaches the filtered list

### Requirement: Runs has honest empty and degraded states
Runs MUST distinguish loading, no machine history, no Current runs, no search matches, stale activity, unavailable history storage, missing detail, and expired detail. A search miss MUST keep both controls available. No empty or degraded state MUST label stale as failed.

#### Scenario: Current is empty but All has runs
- **WHEN** Current contains no runs and retained foreign runs exist
- **THEN** the empty state identifies All folders as the alternate scope

#### Scenario: Search has no matches
- **WHEN** retained runs exist in Location but Search excludes them
- **THEN** Location and Search remain available and the list reports no matching runs
