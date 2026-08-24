## MODIFIED Requirements

### Requirement: List mode opens an actions palette with Ctrl+K
In list mode, `Ctrl+K` MUST open an actions palette and MUST NOT insert into the workflow filter. Printable `k` without a control modifier MUST remain filter text. While the palette is open, a single matching letter MUST fire the action immediately without requiring Enter. Escape MUST close the palette and return to the list without dismissing the picker. The list footer MUST identify `ctrl+k` rather than per-action Ctrl chords. The palette MUST draw its rows with the shared list row chrome, MUST mute an action the current selection cannot fire rather than hide it, and MUST close its body with the separator and the muted footer the other picker screens use.

#### Scenario: Open palette
- **WHEN** the user presses `Ctrl+K` in list mode
- **THEN** the actions palette opens and the filter does not receive a `k`

#### Scenario: Printable k filters
- **WHEN** the user types `k` without a control modifier in list mode
- **THEN** the character is added to the workflow filter

#### Scenario: Escape closes palette
- **WHEN** the actions palette is open and the user presses Escape
- **THEN** the picker returns to list mode and stays open

#### Scenario: Palette uses the shared chrome
- **WHEN** the actions palette is open with no workflow selected
- **THEN** its rows carry the list row indent, the actions that need a selection are muted, and the body ends with the separator and the muted palette footer
