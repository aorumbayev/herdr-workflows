# console-presentation Specification

## Purpose

Full-screen Charm console: workflows list, run-detail debug tabs, placement chooser from the overlay, and `hwf console`.

## Requirements

### Requirement: Console opens at tab, beside, or below
The console pane MUST open with placement `tab`, `beside`, or `below`. `beside` MUST map to herdr `plugin.pane.open` placement `split` with direction `right`. `below` MUST map to `split` with direction `down`. `tab` MUST map to placement `tab`. The overlay placement chooser MUST default to `beside` on the first open in a picker session and MUST remember the last confirmed choice for later opens in that session. `hwf console --placement` MUST accept the same three values and MUST reject any other value.

#### Scenario: Default beside from the overlay
- **WHEN** the user opens the console from the overlay without a prior choice in the session
- **THEN** the placement chooser defaults to `beside`

#### Scenario: Invalid CLI placement
- **WHEN** the user invokes `hwf console --placement popup`
- **THEN** the process exits nonzero naming the allowed placements

### Requirement: Run detail exposes log, transcript, and yaml-at-run
Selecting a run in the console MUST open a detail view with three debug tabs: log, transcript, and yaml-at-run. The log tab MUST render the run's projected detail lines. The transcript and yaml-at-run tabs MUST render the private per-run debug artifacts when present, and MUST say so when absent. Retry-copy MUST copy `hwf run <workflow>` to the clipboard without submitting it.

#### Scenario: Switch debug tabs
- **WHEN** the user presses `2` on a run that captured a transcript
- **THEN** the transcript tab body shows that transcript text

#### Scenario: Retry-copy
- **WHEN** the user presses `y` on a failed run of workflow `alpha`
- **THEN** the clipboard receives `hwf run alpha`
