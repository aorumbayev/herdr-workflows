## ADDED Requirements

### Requirement: Picker console tab forwards pointer events into the embedded console
When the picker Console tab is active, pointer `click` and wheel events that miss the tab bar MUST reach the embedded console model. Coordinates MUST be content-relative and MUST subtract the tab bar row. Tab-bar hits MUST keep switching root tabs. Keyboard twins MUST remain.

#### Scenario: Pointer in the embedded diagram focuses a card
- **WHEN** the picker Console tab shows a diagram and the user `left-click`s a card below the tab bar
- **THEN** the embedded console focuses that card
