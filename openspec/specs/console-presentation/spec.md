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
Selecting a workflow in the console MUST open a read-only `master-detail` diagram derived from the parsed definition. The left rail MUST render each step as a header-strip card: kind on the top border, kind-colored from `tui.Theme`, title, and meta rows for `when:` and placement when present. Cards MUST join with centered muted connectors. The right pane MUST always show the selected step's raw YAML from the workflow file, with hand-rolled highlighting and no extra highlighter module. The right pane MUST scroll when the step source is taller than the viewport, and the console MUST show a muted notice instead of a step chunk when the file text and the parsed steps do not line up. The rail MUST scroll the focused card into view and MUST otherwise leave the window where it is. Step titles MUST prefer a declared id, else a derived label, else `step N`. Derived labels MUST come from `workflow.ProjectDiagram`: herdr method, child workflow name, argv-form run joined to 24 cells, agent prompt first non-empty line truncated to 24 cells. Shell-form `run:` MUST fall back to `step N`. Derived titles MUST carry a muted index suffix. The YAML definition MUST remain the sole source of truth. The same diagram MUST render in the picker console tab and in the popped-out console pane.

#### Scenario: Open diagram from the workflows list
- **WHEN** the user presses Enter on a valid workflow in the console workflows list
- **THEN** the diagram shows that workflow's step cards, conditional meta, pane targets, and the selected step's raw YAML from the parsed definition

#### Scenario: Return from diagram
- **WHEN** the user presses Escape on the diagram view
- **THEN** the console returns to the workflows list

#### Scenario: Long step source scrolls
- **WHEN** the focused step's YAML is taller than the detail viewport
- **THEN** `pgup` and `pgdn`, and the wheel over the right pane, move that source, and moving the focus returns it to the top

#### Scenario: Derived run and agent titles
- **WHEN** the definition has an argv-form run step without an id and an agent step without an id
- **THEN** the run card title uses the joined argv and the agent card title uses the prompt's first non-empty line, each with a muted index suffix

### Requirement: Diagram send-back types an annotation bundle into an agent pane
On the diagram view, send-back MUST stay the existing composer flow with no extra mode. `s` MUST open the instruction prompt even when no step is selected. Empty selection MUST mean the whole workflow. The bundle MUST include the workflow file path, focus step ids, the insert-versus-modify anchor, the typed instruction, and a pointer to `hwf skills show herdr-workflow-create`. The anchor MUST come from the focus: a focused card that declares an id MUST send `step <id>`, a seeded insert MUST send `before <id>` or `after <id>` for that card, and a focused card without a declared id MUST send the whole workflow, because a positional title cannot name a step for the agent. The bundle MUST NOT include inline per-step YAML fragments. The bundle MAY carry an optional failure block naming the run, checkout, step, cause, exit code, and step source. The failure block MUST NOT include the captured output tail. The composer MUST state that an agent pane will edit the workflow file, and MUST name the file, the anchor, and the focus steps from the same label helper the bundle uses. The composer MUST wrap the typed draft on the content width and MUST keep the caret in view, never truncating what the user has typed. The agent MUST edit the workflow file. The loader MUST remain the validation gate. When more than one agent pane exists, the console MUST show a chooser before typing. Bundles larger than the agent prompt cap MUST spill to a private file and type the spill instruction instead. The host call MUST use `pane.send_text`. Sending from the picker popup MUST still hand off to a real agent pane.

#### Scenario: Select steps and send-back to one agent
- **WHEN** the user focuses step `brief` on the handoff diagram, enters instruction text, and only one agent pane is available
- **THEN** that pane receives the bundle text typed but unsubmitted, naming the workflow file and `brief` as focus, with no YAML fragment body

#### Scenario: Choose among multiple agent panes
- **WHEN** the user confirms send-back and two agent panes are available
- **THEN** the console shows a chooser and types into the pane the user selects

#### Scenario: Oversize bundle spills to file
- **WHEN** the assembled annotation bundle exceeds the agent prompt byte cap
- **THEN** the typed text is the spill instruction naming an absolute path, not the raw bundle body

#### Scenario: Composer names the target and the anchor
- **WHEN** the user presses `s` with a card that declares an id focused
- **THEN** the composer says an agent pane edits the file, names the file and `anchor: step <id>`, and a draft wider than one row stays visible

#### Scenario: Card anchor names the focused step
- **WHEN** the user presses `d` on a card that declares an id and confirms the seeded instruction
- **THEN** the bundle anchor names that step id

#### Scenario: Empty selection sends the whole workflow
- **WHEN** the user presses `s` with no step selected and confirms an instruction
- **THEN** the bundle names the workflow file and treats the whole workflow as the focus

#### Scenario: Failure block names cause without output tail
- **WHEN** send-back includes an optional failure block for a failed step
- **THEN** the bundle names the run, checkout, step, cause, exit code, and step source, and does not include the captured output tail

### Requirement: Console watches the workflow file and keeps last-good diagram
While the diagram is open, the console MUST watch the workflow file and re-render on change from any writer. A shared poll MUST drive this watch. Exactly one poll MUST stay armed for the open diagram: a tick left from an earlier diagram MUST stop instead of arming another. A successful load MUST replace the diagram. A failed load MUST keep the last successfully loaded diagram and MUST show the loader error on the status line. Scroll offset MUST stay. Selection MUST re-resolve by declared step id: a still-present `{step: id}` stays, a missing id drops, a positional `step N` title drops.

#### Scenario: Valid save refreshes the rail
- **WHEN** the watched workflow file is overwritten with a valid definition
- **THEN** the diagram re-renders from the new parse without leaving the diagram view

#### Scenario: Invalid save keeps last-good
- **WHEN** the watched workflow file is overwritten with YAML the loader rejects
- **THEN** the rail still shows the last good diagram and the status line shows the loader error

#### Scenario: Stale poll tick dies
- **WHEN** the user leaves the diagram and opens one again while an earlier poll tick is still in flight
- **THEN** the earlier tick stops and the poll rate stays the same

#### Scenario: Selection follows declared ids
- **WHEN** a card `{step: build}` is selected and a reload removes that id
- **THEN** that card is no longer selected and the scroll offset is unchanged

### Requirement: Diagram mouse navigates and never writes YAML
The diagram MUST be mouse-navigable and MUST NOT be mouse-editable. A left `click` on a card MUST focus it. `Ctrl+click` MUST add or remove a card with a declared id from the multi-select set. Every card MUST carry a selection mark slot: selected, unselected, or unavailable when the step declares no id. `v` and `ctrl+click` on a card without a declared id MUST say why it cannot be selected instead of doing nothing, and the console MUST clear that reason when the focus moves. Wheel MUST scroll the rail. The console MUST NOT drag-reorder. The rail cursor MUST step card to card: connectors are decoration, MUST NOT be hit targets, and MUST have no selected state. `a` MUST ask which side of the focused card the new step goes on. That prompt MUST offer exactly `before` and `after`, MUST be keyboard-first with arrows and `enter`, MUST accept `b` and `a` as direct picks, and MUST cancel on `esc`. Confirming MUST open the existing composer pre-filled with that side named. `d` MUST open the same composer pre-filled for the focused card. No canned instruction MAY send unseen. Select a card MUST match arrows. The picker console tab and the popped-out pane MUST share this interactivity. `internal/console` MUST NOT grow a YAML writer.

#### Scenario: Pointer focuses a card
- **WHEN** the user uses a left `click` on a step card
- **THEN** that card is focused and the YAML pane shows that step's source chunk

#### Scenario: Multi-select uses declared ids
- **WHEN** the user uses `ctrl+click` on two cards that declare ids
- **THEN** both ids are in the send-back focus set

#### Scenario: Card without an id shows an unavailable mark
- **WHEN** the diagram holds a step that declares no id and the user presses `v` on it
- **THEN** that card shows a muted unavailable mark, the status line says the step declares no id, and the selection set does not change

#### Scenario: `a` asks before or after the focused card
- **WHEN** the user presses `a` while a card is focused
- **THEN** a two-option prompt offers `before` and `after` that card, and confirming opens the composer with that insert instruction the user can edit

#### Scenario: Insert side prompt cancels
- **WHEN** the user presses `esc` on the insert-side prompt
- **THEN** the diagram returns with no composer and no anchor side kept

#### Scenario: Arrows step card to card
- **WHEN** the user presses the down arrow on the first card
- **THEN** the focus lands on the next card, with no stop on the connector between them

### Requirement: Console mouse reporting is on in both hosts
The console TUI MUST enable Bubble Tea mouse cell reporting in the standalone `hwf console` pane and in the picker-hosted console tab. The picker MUST forward Select and wheel events that land in the console body to the embedded console, shifted past the tab bar. Wheel on the diagram MUST scroll the rail. When the plugin has not enabled reporting, `click`s MUST NOT be the only path: keyboard navigation MUST still work.

#### Scenario: Standalone console reports mouse
- **WHEN** `hwf console` renders its view
- **THEN** the view's mouse mode is all-motion so herdr can forward `click`s and wheel

#### Scenario: Picker console tab forwards wheel
- **WHEN** the picker Console tab shows a diagram and the user wheels over the rail
- **THEN** the embedded console scrolls the rail

### Requirement: Picker hosts a browse console tab with pop-out
The picker Console root browser MUST embed the console TUI for diagram browse inside the picker popup. A working console session MUST use pop-out: the existing overlay placement chooser (`tab`, `beside`, `below`) MUST open a herdr-owned console pane and MUST quit the picker. The standalone `hwf console` pane MUST keep the same three placements.

#### Scenario: Browse in the popup
- **WHEN** the user cycles to the Console picker tab with a valid workflow selected in the Workflow tab
- **THEN** the embedded console shows that workflow's diagram from the parsed definition, without a second workflow list

#### Scenario: Leave the diagram for the workflows tab
- **WHEN** the embedded diagram is open and the user presses `esc` or `tab`
- **THEN** the picker returns to the Workflow browser and no key is swallowed

#### Scenario: Embedded console fits below the tab bar
- **WHEN** the Console picker tab draws in a popup of any height
- **THEN** the composed frame is no taller than the popup and the console footer stays visible

#### Scenario: Pop-out uses placement
- **WHEN** the user pops the console out and confirms `beside`
- **THEN** herdr opens the console pane beside and the picker exits

