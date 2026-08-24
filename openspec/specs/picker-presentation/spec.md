# picker-presentation Specification

## Purpose
Picker popup layout: pane title, fixed single-line rows, selected-workflow detail, footer, filter matching, width-derived truncation, and ASCII chrome.
## Requirements
### Requirement: The picker names itself once
The picker popup MUST take its title from the herdr pane label. It MUST NOT render a title, plugin name, or repository name as a body row. The pane label MUST be a static value. The picker MUST NOT set that label at runtime through a herdr pane metadata call.

#### Scenario: Title appears only in the pane label
- **WHEN** the picker mounts its list view
- **THEN** no rendered row contains the plugin name or the repository basename

#### Scenario: No runtime retitling
- **WHEN** the picker starts
- **THEN** it issues no `pane.report_metadata` call, so no other pane can be renamed by it

### Requirement: Rows are fixed-width columns, not a joined badge chain
Each row MUST render a left-aligned workflow title, a fixed-width warning column, and a right-aligned location of `global`, `repo`, or `invalid`. The row MUST NOT render a workflow's declared-inputs marker, and it MUST NOT render individual sensitivity flag names. When a title is longer than the title field, the picker MUST truncate it with an ellipsis, so the warning and location columns keep their positions.

#### Scenario: Sensitive workflow
- **WHEN** a workflow shells out, reads the transcript, or calls sensitive herdr methods
- **THEN** its row shows a single warning marker in the warning column and no flag names

#### Scenario: Unbounded flag list does not widen the row
- **WHEN** a workflow carries several sensitive methods and an unresolved child
- **THEN** its row occupies the same width as a workflow with no flags

#### Scenario: Overlong title
- **WHEN** a workflow title exceeds the title field
- **THEN** the title is truncated with an ellipsis and the location remains right-aligned in its column

#### Scenario: Inputs are not advertised in the row
- **WHEN** a workflow declares inputs
- **THEN** its row is indistinguishable from a workflow without inputs, and the input prompt still appears after the workflow is chosen

### Requirement: Sensitivity flag names appear at the point of consent
The picker MUST present the named sensitivity flags for a workflow before the run starts. It MUST use a color distinct from muted body text and MUST NOT rely on color alone.

#### Scenario: Flags shown before run
- **WHEN** a user selects a workflow that reads the session transcript and runs shell commands
- **THEN** the picker presents the flag names before launching the run

#### Scenario: Warnings are not the least legible element
- **WHEN** sensitivity information is rendered
- **THEN** it uses the theme's warning color without a dim attribute

### Requirement: Invalid workflows appear in the list
Workflows that fail to load MUST appear as rows in the same list, with location `invalid`. Selecting one MUST show its load error in the detail row. The picker MUST NOT render a separate block of invalid entries.

#### Scenario: Repository with a broken workflow file
- **WHEN** one workflow file fails to parse
- **THEN** it appears as a list row marked `invalid` and no separate invalid-entry block is rendered

#### Scenario: Selecting an invalid workflow
- **WHEN** the cursor rests on an `invalid` row
- **THEN** the detail row shows that workflow's load error

### Requirement: The selected workflow's detail is separated from the footer
The picker MUST render the description of the selected workflow below the list, across at most two word-wrapped lines. A muted horizontal rule, inset from the popup border on both sides, MUST separate the description from the footer. Wrapping MUST break on word boundaries unless a single word exceeds the line budget. When a description is too long for two lines, the picker MUST truncate it with an ellipsis on the second line. The detail rows and rule MUST hold their position regardless of how many workflows match or how many lines the description occupies.

#### Scenario: Long description wraps instead of cropping
- **WHEN** a description is longer than one line but fits two
- **THEN** it wraps at a word boundary and no ellipsis is shown

#### Scenario: Description too long for two lines
- **WHEN** a description exceeds two lines
- **THEN** the second line ends with an ellipsis and neither line exceeds the content width

#### Scenario: Cursor moves
- **WHEN** the cursor moves to another workflow
- **THEN** the detail row content changes and no other row shifts position

#### Scenario: Rule does not touch the border
- **WHEN** the separator is drawn
- **THEN** it stops short of the left and right popup borders and uses the muted color, not the border color

### Requirement: Footer fits the popup and reports position
The footer hint MUST fit within the usable popup width without truncation. When the filtered list has at least one workflow, a right-aligned position counter of the cursor index over the number of matching workflows MUST accompany it. When the filtered list is empty, the counter MUST be omitted. The picker MUST NOT render the list's built-in scroll indicator. The list-mode hint MUST identify run (when workflows can be selected), the actions palette (`ctrl+k`), and dismiss — not per-action Ctrl chords.

#### Scenario: Hint is not clipped
- **WHEN** the picker renders its footer at the popup's usable width
- **THEN** the full hint text is visible

#### Scenario: Position counter reflects the filtered list
- **WHEN** a filter narrows eight workflows to two and the cursor rests on the first
- **THEN** the counter reads the first position over two

#### Scenario: No scroll thumb
- **WHEN** more workflows match than fit the viewport
- **THEN** no scroll indicator glyph is drawn in the right-most content column

#### Scenario: Regular list footer
- **WHEN** the picker displays a non-empty filtered workflow list
- **THEN** its footer identifies run, `ctrl+k`, and dismiss

### Requirement: Filter matches the text the user can see
Filtering MUST match case-insensitively against both the workflow's displayed title and its name.

#### Scenario: Filtering by displayed title
- **WHEN** a workflow named `pr-desc` has title `Draft PR description` and the user types `draft`
- **THEN** that workflow matches

#### Scenario: Filtering by name
- **WHEN** the same workflow is filtered by `pr-desc`
- **THEN** that workflow matches

#### Scenario: Case is ignored
- **WHEN** the user types `HANDOFF`
- **THEN** a workflow titled `Handoff` matches

### Requirement: Truncation derives from the rendered width
Every rendered picker line MUST fit the current renderer width measured in terminal columns, truncated at a grapheme boundary when it would otherwise overflow, and MUST be recomputed when that width changes.

#### Scenario: Narrow host pane
- **WHEN** the popup is narrower than its requested width
- **THEN** rows, detail, and progress lines truncate to the available width instead of being clipped by the border

#### Scenario: Width changes mid-session
- **WHEN** the renderer width changes while the picker is open
- **THEN** truncation widths are recomputed for subsequent rendering

### Requirement: Picker chrome uses width-stable ASCII glyphs
Every glyph the picker renders MUST have unambiguous single-column width in every locale, and layout arithmetic MUST measure terminal columns rather than characters.

#### Scenario: CJK locale
- **WHEN** the picker renders in a terminal using an East-Asian locale
- **THEN** no chrome glyph occupies two columns and column alignment is preserved

#### Scenario: Font without box or arrow glyphs
- **WHEN** the terminal font lacks arrow, triangle, or heavy-line glyphs
- **THEN** all picker chrome still renders

#### Scenario: Charm flush-left filter without slash prefix
- **WHEN** the Workflow browser shows an empty or typed filter row
- **THEN** the filter text is flush-left ASCII with the `filter workflows...` placeholder (or the typed text) and MUST NOT use a `/ ` prefix or row indent for that field

#### Scenario: ASCII greater-than cursor on choice option rows
- **WHEN** a choice input shows its option list
- **THEN** the selected option uses an ASCII `>` cursor prefix, idle options use a two-space prefix, each option row keeps a right-aligned location column, and the list MUST NOT use a `/ ` prefix or box or arrow glyphs

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

### Requirement: Input prompts state what they collect
An input prompt MUST render the input name, the author description when one is declared, and how the
value is supplied. It MUST render the prompt's ordinal position, counted over the inputs already
answered in the current collection. For a resolved closed domain it MUST report the number of
available options. For a domain that is not yet resolved it MUST NOT state a count. It MUST report
when a value outside the listed options is accepted, and MUST report a text input's default and its
minimum length when either is declared. The prompt MUST NOT change the workflow title row, the list
viewport, or the footer key hints. During input collection the workflow title row MUST keep the
named sensitivity flags and MUST NOT replace them with an `input N` ordinal.

#### Scenario: Dropdown of many options
- **WHEN** a choice input resolves to sixty-seven options
- **THEN** the prompt names the input, shows its description, and reports that one of sixty-seven is
  to be picked

#### Scenario: Undescribed input
- **WHEN** an input declares no description
- **THEN** the prompt still reports the input name, its ordinal position, and how to supply a value

#### Scenario: Custom value accepted
- **WHEN** a choice input sets `allow_custom: true`
- **THEN** the prompt reports that a value outside the listed options may be typed

#### Scenario: Constrained text input
- **WHEN** a text input declares a default and a minimum length
- **THEN** the prompt reports both alongside the free-text instruction

#### Scenario: Unresolved dynamic domain
- **WHEN** a dynamic choice has not resolved its options
- **THEN** the prompt asks for a selection without claiming a count

#### Scenario: Title row keeps named sensitivity flags
- **WHEN** a sensitive workflow reaches its first input prompt
- **THEN** the workflow title row keeps the named sensitivity flags and MUST NOT replace them with
  `input N`, while the prompt line carries the collection ordinal

### Requirement: Collected answers stay visible during collection
While collecting inputs, the picker MUST render the answers already collected, in declaration order,
as name and value pairs below the prompt. It MUST omit that line before the first answer, and MUST
truncate it to the content width. The line MUST reflect discarded answers after a backward
navigation.

#### Scenario: A guarded domain is explained by an earlier answer
- **WHEN** a user answers `mode` with `delete` and reaches the guarded `worktree` prompt
- **THEN** the prompt area shows that `mode` is `delete`

#### Scenario: First prompt has no answers
- **WHEN** the first active input is presented
- **THEN** no collected-answer line is rendered

#### Scenario: Answers exceed the popup width
- **WHEN** the collected answers are longer than the content width
- **THEN** the line is truncated with an ellipsis and the layout does not shift

#### Scenario: Backward navigation drops later answers
- **WHEN** a user navigates back to `mode` and changes it, discarding later answers
- **THEN** the collected-answer line no longer lists the discarded inputs

### Requirement: Empty catalog shows a friendly empty state without a filter
When the picker has no visible workflows, it MUST mount list mode with a friendly empty state. The message MUST explain that no runnable workflows exist and that the actions palette can create, browse examples, or import. The picker MUST NOT show the workflow filter input. The footer MUST identify `tab`, the actions palette (`ctrl+k`), and dismiss. It MUST NOT list per-action chords.

#### Scenario: Hotkey with no workflows
- **WHEN** the user opens the picker and neither the repository nor global workflow directories contain a visible workflow
- **THEN** the picker stays open, shows the empty-state message, hides the filter, and does not exit for an empty catalog

#### Scenario: Empty footer
- **WHEN** the empty state is shown
- **THEN** the footer identifies `tab`, `ctrl+k`, and `esc` and does not claim run, edit, share, or import chords

### Requirement: Filter miss is distinct from an empty catalog
When visible workflows exist but the current filter matches none, the picker MUST keep the filter visible and MUST show a message that no workflows match the filter text. It MUST NOT reuse the empty-catalog copy.

#### Scenario: No matches for filter
- **WHEN** the catalog has visible workflows and the user types a filter that matches none
- **THEN** the detail or status area reports that no workflows match that filter and the filter input remains

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
The Runs filter MUST match case-insensitively against workflow title and name, run ID, status, safe step labels, and allowlisted failure facts. It MUST NOT match private failure explanation text. Runs MUST default to the exact current checkout root. `Ctrl+G` MUST toggle Current and All without entering filter text. The stdin pre-handler MUST preserve raw `0x07` for Ctrl+G. The active scope MUST be visible without consuming a list row. Printable `g` MUST remain filter text.

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
After the final input is accepted, the picker MUST allocate a full run UUID, launch the child with that private identity, and immediately open matching local detail in `STARTING` state. The child MUST exclusively claim that snapshot identity and send one machine-readable acknowledgement through the observed launch channel. A successful claim MUST move detail to attached `RUNNING`. Unavailable storage MUST move detail to `RUNNING | HISTORY UNAVAILABLE`. A rejected claim or spawn failure MUST remain a picker-local launch failure. Success, failure, and interruption MUST remain visible until the user leaves detail and MUST NOT auto-dismiss the picker.

#### Scenario: Child acknowledges start
- **WHEN** the picker spawns a workflow child and receives its successful snapshot-claim acknowledgement
- **THEN** the open detail changes from starting to running for that exact UUID

#### Scenario: Child cannot record history
- **WHEN** the child acknowledges that private history storage is unavailable
- **THEN** the open detail identifies unavailable history, continues attached progress observation, and does not claim a durable record

#### Scenario: Child fails before claim
- **WHEN** the detached child exits without acknowledging a matching snapshot claim
- **THEN** the open detail reports a local launch failure and does not present it as durable history

#### Scenario: Fast successful workflow
- **WHEN** a launched workflow succeeds before the user leaves detail
- **THEN** the detail changes to succeeded, shows every step outcome and elapsed time, and stays open

#### Scenario: Leave an active launch
- **WHEN** a directly launched run is still active and the user presses Escape
- **THEN** the picker detaches direct child observation, returns to the Runs root, and the workflow continues

### Requirement: Picker console tab forwards pointer events into the embedded console
When the picker Console tab is active, pointer `click` and wheel events that miss the tab bar MUST reach the embedded console model. Coordinates MUST be content-relative and MUST subtract the tab bar row. Tab-bar hits MUST keep switching root tabs. Keyboard twins MUST remain.

#### Scenario: Pointer in the embedded diagram focuses a card
- **WHEN** the picker Console tab shows a diagram and the user `left-click`s a card below the tab bar
- **THEN** the embedded console focuses that card

### Requirement: List viewport fills the popup above a six-row floor
The list MUST render one line per workflow. The visible row count MUST come from the host height less the list chrome, and MUST never drop below six. The list chrome MUST reserve a status row whether or not a status is set, so the frame keeps the same line count. A frame that changes its line count makes the inline renderer erase and redraw the whole frame, which reads as a blink. A host of unknown height MUST render six rows. The list MUST NOT reserve a second line per row for descriptions. Blank rows MUST hold the detail block, separator, and footer in place when fewer workflows match. Pointer hit rows MUST use the same visible count as the keyboard cursor.

#### Scenario: More workflows than the viewport
- **WHEN** eight workflows match the current filter in a host that fits six rows
- **THEN** the list renders six single-line rows and the remaining two are reachable by cursor movement

#### Scenario: Cursor moves beyond the viewport
- **WHEN** the cursor moves past the last visible row
- **THEN** the viewport scrolls to keep the cursor visible and the footer, detail row, and separator stay in place

#### Scenario: Fewer matches than the viewport
- **WHEN** two workflows match the current filter
- **THEN** the list renders two rows, leaves the remaining list rows blank, and does not move the detail row, separator, or footer

#### Scenario: Tall popup shows more rows
- **WHEN** eight workflows match the current filter in a popup 30 rows tall
- **THEN** every match renders without cursor movement

#### Scenario: Tall host shows more runs
- **WHEN** the runs list holds eight runs in a host 30 rows tall
- **THEN** every run renders without cursor movement

#### Scenario: Run detail fills the host
- **WHEN** a run detail body is taller than ten lines in a host 30 rows tall
- **THEN** the detail body renders more than ten lines above the separator

#### Scenario: Status row is reserved
- **WHEN** a status appears under the detail block and later clears
- **THEN** the frame keeps the same number of lines and nothing below it moves

#### Scenario: Pointer hit rows follow the viewport
- **WHEN** the user selects the last visible row of a tall popup
- **THEN** the cursor lands on that row

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

### Requirement: Failed run detail offers send-back to an agent
On the failed-run detail, `s` MUST assemble a send-back bundle from the focused failed step and type it into a target agent pane input without submitting it. The bundle MUST reuse the console annotation bundle and MUST add a `--- failure ---` block carrying the run, checkout, step, cause, exit code, and step source. The bundle MUST NOT include the captured output tail. When more than one agent pane exists, the picker MUST show a chooser before typing. Bundles larger than the agent prompt cap MUST spill to a private file and type the spill instruction instead. The host call MUST use `pane.send_text`.

#### Scenario: Send back the failed step
- **WHEN** the user focuses a failed step and presses `s` with one agent pane available
- **THEN** that pane receives a bundle with a `--- failure ---` block naming the cause and step source

#### Scenario: Choose an agent pane
- **WHEN** the user confirms send-back and two agent panes are available
- **THEN** the picker shows a chooser and types into the pane the user selects

