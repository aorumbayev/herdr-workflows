## MODIFIED Requirements

### Requirement: Tab switches the three root browsers
The picker MUST provide Workflow, Runs, and Console root browsers in the existing popup. Tab MUST cycle them in that order whenever a root browser is active, including while a filter has focus. Tab MUST NOT switch during input collection, live launch, run detail, an actions palette, or confirmation. The pane title MUST remain static. A visible tab bar MUST name the three browsers and MUST mark the active tab. Inactive tabs MUST use a distinct muted state. Pointer select on a tab MUST switch to that browser and MUST have a keyboard equivalent (Tab cycle).

#### Scenario: Workflow filter has text
- **WHEN** the Workflow browser filter has focus and the user presses Tab
- **THEN** the Runs browser opens and no tab character enters either filter

#### Scenario: Input collection
- **WHEN** a workflow input prompt is active and the user presses Tab
- **THEN** the picker does not switch root browsers

#### Scenario: Cycle past runs
- **WHEN** the Runs root browser is active and the user presses Tab
- **THEN** the Console browser opens with the static Herdr pane title unchanged

#### Scenario: Return to workflows
- **WHEN** the Console root browser is active and the user presses Tab
- **THEN** the Workflow browser returns with the static Herdr pane title unchanged

#### Scenario: Tab bar shows the active browser
- **WHEN** the picker shows a root browser
- **THEN** the tab bar includes `workflows`, `runs`, and `console`, and the active name is visually distinct from the inactive names

### Requirement: Empty catalog shows a friendly empty state without a filter
When the picker has no visible workflows, it MUST mount list mode with a friendly empty state. The message MUST explain that no runnable workflows exist and that the actions palette can create, browse examples, or import. The picker MUST NOT show the workflow filter input. The footer MUST identify `tab`, the actions palette (`ctrl+k`), and dismiss. It MUST NOT list per-action chords.

#### Scenario: Hotkey with no workflows
- **WHEN** the user opens the picker and neither the repository nor global workflow directories contain a visible workflow
- **THEN** the picker stays open, shows the empty-state message, hides the filter, and does not exit for an empty catalog

#### Scenario: Empty footer
- **WHEN** the empty state is shown
- **THEN** the footer identifies `tab`, `ctrl+k`, and `esc` and does not claim run, edit, share, or import chords

### Requirement: Popup geometry follows the active root tab
The picker popup MUST declare compact cell geometry in `herdr-plugin.toml`: width `64` and height `15`. The Workflow and Runs browsers MUST use that size. The Console browser MUST use `85%` by `80%`. herdr cannot resize a live popup, so a switch to a tab that needs a different size MUST carry the tab, filter, cursor, and offset into a state payload, MUST let this popup close, and MUST open the picker entrypoint again at the new size through `plugin.pane.open` with that payload in `env`. A popup is a session singleton, so the reopen MUST come from a detached process that outlives this one and MUST retry while the outgoing popup is still open. A switch between tabs of the same size MUST NOT respawn. The restored process MUST open on its saved tab and MUST NOT respawn again for that tab.

#### Scenario: Manifest uses the compact size
- **WHEN** herdr opens the picker pane from the plugin manifest
- **THEN** that pane requests width `64` and height `15`

#### Scenario: Console tab respawns the popup
- **WHEN** the user cycles from the Runs browser to the Console browser
- **THEN** the picker hands its state to a reopen at `85%` by `80%` and this popup exits

#### Scenario: Same-size switch stays in place
- **WHEN** the user cycles from the Workflow browser to the Runs browser
- **THEN** the popup does not close and the browser switches in place

#### Scenario: Restored picker does not respawn
- **WHEN** a respawned picker opens on the Console tab
- **THEN** it mounts that tab at the size it was opened with and requests no further reopen

### Requirement: Console browse has a pop-out path
The Console root browser MUST embed the console TUI for browsing. The embedded console MUST draw inside the popup rows the tab bar leaves it. Opening the Console browser MUST show the diagram of the workflow the Workflow browser has selected: the picker list is the selector, and the popup MUST NOT hold a second workflow list. `esc` and `tab` on that diagram MUST return to the Workflow browser, and neither key may die inside a browse screen. The standalone `hwf console` pane MUST keep its own workflow list. `p` on that browser MUST open the existing console placement chooser (`beside`, `tab`, `below`). Confirming a placement MUST open the console in a herdr pane and MUST quit the picker. Canceling MUST return to the browser it was opened from and MUST NOT change the workflow filter. The actions palette `c` path MUST keep the same placement flow. Pop-out MUST work from the keyboard.

#### Scenario: Pop-out from the console tab
- **WHEN** the Console root browser is active and the user presses `p`
- **THEN** the placement chooser opens

#### Scenario: Canceled pop-out keeps the workflow filter
- **WHEN** the user types a workflow filter, cycles to the Console browser, presses `p`, and presses Escape
- **THEN** the Console browser returns and the typed filter is unchanged

#### Scenario: Console tab follows the popup size and selection
- **WHEN** the popup is resized or the catalog changes while another tab is active
- **THEN** the next visit to the Console browser draws at the current size and shows the diagram of the currently selected workflow

#### Scenario: Confirmed pop-out quits the picker
- **WHEN** the user confirms a console placement
- **THEN** the console pane opens at that placement and the picker exits

### Requirement: Picker mouse reporting is on and never exclusive
The picker host MUST enable Bubble Tea mouse reporting with cell motion, including hover motion. Pointer hover MUST use a style other than reverse-video. Reverse-video MUST remain the cursor on the selected row and MUST win when hover and cursor share a row. Wheel MUST move the list cursor. Pointer select on a row MUST move the cursor. No picker gesture MAY exist only as a pointer action.

#### Scenario: Hover differs from the cursor
- **WHEN** the pointer rests on a list row that is not selected
- **THEN** that row uses the hover style and the selected row keeps reverse-video

#### Scenario: Pointer select on the active tab changes nothing
- **WHEN** the user selects the tab that is already active
- **THEN** that browser keeps its state and does not reload

#### Scenario: Wheel has a keyboard twin
- **WHEN** the user scrolls the wheel over the workflow list
- **THEN** the cursor moves as with Up or Down

### Requirement: Picker chrome uses the shared kind theme
`tui.Theme` MUST expose indexed ANSI kind colors agent `6`, run `2`, herdr `5`, workflow `4`, and default `7`, plus warn `3`, reverse selection, and a hover style that is not reverse. Content text MUST keep the terminal's own foreground: workflow list titles, the selected description, and plain YAML values MUST NOT pin a palette slot, because a slot the user's theme renders dark on their background makes that text unreadable. Secondary text MUST be faint rather than a palette slot, so it derives from the reader's foreground and stays readable on a terminal that drops the attribute. The location column MUST be faint, except `invalid`, which MUST use warn, and MUST drop the faint attribute on the cursor row. The sensitivity `!` marker MUST use warn. Footer hints, the rule, and the tab bar's inactive labels MUST be faint. Runs-tab status text MUST use succeeded `2`, failed `1`, interrupted `3`, running `6`, and a faint stale. Color MUST NOT be the only signal for any state. Visual changes MUST land with re-judged rows in `internal/picker/parity.go` and `tui.CharmVerdicts`.

#### Scenario: Invalid location uses warn
- **WHEN** a list row has location `invalid`
- **THEN** that location uses the theme warn color

#### Scenario: Sensitivity marker uses warn
- **WHEN** a workflow row carries sensitivity
- **THEN** its `!` marker uses the theme warn color without a dim attribute

#### Scenario: Content keeps the terminal foreground
- **WHEN** a clean list row and its description render
- **THEN** neither pins a palette slot, and only the faint location column separates them from the title

#### Scenario: Runs status uses indexed slots
- **WHEN** the Runs browser shows a failed run
- **THEN** the status text uses ANSI index `1` and still includes a textual status label
