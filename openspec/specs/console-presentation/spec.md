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

### Requirement: Workflow diagram projects the parsed definition
Selecting a workflow in the console MUST open a read-only diagram derived from the parsed definition. The diagram MUST show each step node, each step's `when:` edges, and each step's placement targets. The projection MUST be static for the load. The YAML definition MUST remain the sole source of truth.

#### Scenario: Open diagram from the workflows list
- **WHEN** the user presses Enter on a valid workflow in the console workflows list
- **THEN** the diagram shows that workflow's step ids, conditional edges, and pane targets from the parsed definition

#### Scenario: Return from diagram
- **WHEN** the user presses Escape on the diagram view
- **THEN** the console returns to the workflows list

### Requirement: Diagram send-back types an annotation bundle into an agent pane
On the diagram view, `v` MUST enter step selection mode where the user toggles step nodes by id. `s` MUST open an instruction prompt, assemble an annotation bundle from the selected step ids, their YAML fragments, and the typed instruction, and type that bundle into a target agent pane input without submitting it. When more than one agent pane exists, the console MUST show a chooser before typing. Bundles larger than the agent prompt cap MUST spill to a private file and type the spill instruction instead. The host call MUST use `pane.send_text`.

#### Scenario: Select steps and send-back to one agent
- **WHEN** the user selects step `brief` on the handoff diagram, enters instruction text, and only one agent pane is available
- **THEN** that pane receives the bundle text typed but unsubmitted

#### Scenario: Choose among multiple agent panes
- **WHEN** the user confirms send-back and two agent panes are available
- **THEN** the console shows a chooser and types into the pane the user selects

#### Scenario: Oversize bundle spills to file
- **WHEN** the assembled annotation bundle exceeds the agent prompt byte cap
- **THEN** the typed text is the spill instruction naming an absolute path, not the raw bundle body
