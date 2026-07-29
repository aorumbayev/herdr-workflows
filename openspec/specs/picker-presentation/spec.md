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

### Requirement: Fixed visible list viewport
The list MUST render one line per workflow and MUST show six workflows at a time. Explicit list height MUST fix the visible count, rather than deriving it from remaining flex space. The list MUST NOT reserve a second line per row for descriptions.

#### Scenario: More workflows than the viewport
- **WHEN** eight workflows match the current filter
- **THEN** the list renders six single-line rows and the remaining two are reachable by cursor movement

#### Scenario: Cursor moves beyond the viewport
- **WHEN** the cursor moves past the last visible row
- **THEN** the viewport scrolls to keep the cursor visible and the footer, detail row, and separator stay in place

#### Scenario: Fewer matches than the viewport
- **WHEN** two workflows match the current filter
- **THEN** the list renders two rows, leaves the remaining list rows blank, and does not move the detail row, separator, or footer

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
The footer hint MUST fit within the usable popup width without truncation. A right-aligned position counter of the cursor index over the number of matching workflows MUST accompany it. The picker MUST NOT render the list's built-in scroll indicator.

#### Scenario: Hint is not clipped
- **WHEN** the picker renders its footer at the popup's usable width
- **THEN** the full hint text is visible

#### Scenario: Position counter reflects the filtered list
- **WHEN** a filter narrows eight workflows to two and the cursor rests on the first
- **THEN** the counter reads the first position over two

#### Scenario: No scroll thumb
- **WHEN** more workflows match than fit the viewport
- **THEN** no scroll indicator glyph is drawn in the right-most content column

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
All picker text truncation — row titles, the detail row, and run progress lines — MUST be computed from the renderer's current width, rather than from fixed character limits, and MUST follow a width change.

#### Scenario: Narrow host pane
- **WHEN** the popup is narrower than its requested width
- **THEN** rows, detail, and progress lines truncate to the available width instead of being clipped by the border

#### Scenario: Width changes mid-session
- **WHEN** the renderer width changes while the picker is open
- **THEN** truncation widths are recomputed for subsequent rendering

### Requirement: Picker chrome uses width-stable ASCII glyphs
Every glyph the picker draws as chrome — filter prompt, cursor marker, warning marker, and separator — MUST be a printable ASCII character, so no chrome glyph has ambiguous display width.

#### Scenario: CJK locale
- **WHEN** the picker renders in a terminal using an East-Asian locale
- **THEN** no chrome glyph occupies two columns and column alignment is preserved

#### Scenario: Font without box or arrow glyphs
- **WHEN** the terminal font lacks arrow, triangle, or heavy-line glyphs
- **THEN** all picker chrome still renders

### Requirement: Input navigation preserves valid answers
Escape from an input prompt MUST move to the previous active input and restore its collected value. Escape from the first active input MUST return to the workflow list. Changing an earlier value MUST discard all later answers and resolved dynamic-choice domains before active inputs are recalculated. Returning to the list MUST clear the collection. Escape and Enter after a terminal run failure MUST both dismiss with a nonzero status.

#### Scenario: Correct the final answer
- **WHEN** a user presses Escape on the last of three active inputs
- **THEN** the picker returns to the second input and preserves the first input's answer

#### Scenario: Mode change alters active inputs
- **WHEN** a user navigates back, changes `mode` from `create` to `delete`, and continues
- **THEN** later create-only answers are discarded and only delete-active inputs are collected

#### Scenario: Failed run dismissal
- **WHEN** a run has failed and the user presses Escape
- **THEN** the picker exits nonzero just as it does when the user presses Enter

### Requirement: Input prompts state what they collect
An input prompt MUST render the input name, the author description when one is declared, and how the
value is supplied. It MUST render the prompt's ordinal position, counted over the inputs already
answered in the current collection. For a resolved closed domain it MUST report the number of
available options; for a domain that is not yet resolved it MUST NOT state a count. It MUST report
when a value outside the listed options is accepted, and MUST report a text input's default and its
minimum length when either is declared. The prompt MUST NOT change the workflow title row, the list
viewport, or the footer key hints.

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
