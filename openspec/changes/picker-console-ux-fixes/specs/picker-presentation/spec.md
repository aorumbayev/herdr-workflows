## REMOVED Requirements

### Requirement: Fixed visible list viewport
**Reason**: The six-row lock came from the 64 by 15 popup. The popup is now 85% by 80%, where a fixed count leaves most of the frame empty.
**Migration**: The floor stays six rows, so a short host renders what it rendered before.

## ADDED Requirements

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
