## ADDED Requirements

### Requirement: Empty catalog shows a friendly empty state without a filter
When the picker has no visible workflows, it MUST mount list mode with a friendly empty-state message explaining that there are no runnable workflows and that the user can create, browse examples, or import via the actions palette. It MUST NOT show the workflow filter input. The footer MUST identify only the actions palette and dismiss controls.

#### Scenario: Hotkey with no workflows
- **WHEN** the user opens the picker and neither the repository nor global workflow directories contain a visible workflow
- **THEN** the picker stays open, shows the empty-state message, hides the filter, and does not exit for an empty catalog

#### Scenario: Empty footer
- **WHEN** the empty state is shown
- **THEN** the footer identifies `ctrl+k` and `esc` and does not claim run, edit, share, or import chords

### Requirement: Filter miss is distinct from an empty catalog
When visible workflows exist but the current filter matches none, the picker MUST keep the filter visible and MUST show a message that no workflows match the filter text. It MUST NOT reuse the empty-catalog copy.

#### Scenario: No matches for filter
- **WHEN** the catalog has visible workflows and the user types a filter that matches none
- **THEN** the detail or status area reports that no workflows match that filter and the filter input remains

## MODIFIED Requirements

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
