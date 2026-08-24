# picker-editor-actions — delta

## ADDED Requirements

### Requirement: Palette labels are single words and unavailable actions are hidden
The actions palette MUST label each action with a single word: `new`, `import`, `examples`, `console`, `edit`, `share`, and `delete`. The bare-letter keys MUST stay `n i e c o s d`. `new`, `import`, `examples`, and `console` MUST always be present. `edit`, `share`, and `delete` MUST be hidden when no valid workflow is selected and MUST appear when one is. A hidden action MUST NOT be reachable by its letter.

#### Scenario: Empty catalog palette
- **WHEN** the catalog has no valid workflow and the user opens the actions palette
- **THEN** only `new`, `import`, `examples`, and `console` are listed

#### Scenario: Selected workflow palette
- **WHEN** a valid workflow is selected and the user opens the actions palette
- **THEN** all seven single-word labels are listed

## MODIFIED Requirements

### Requirement: Palette open edits the selected workflow
`o` in the actions palette MUST open a placement chooser for the selected valid workflow: `popup` (the default), `beside`, `below`, or `tab`. `popup` MUST respawn the picker popup at the console size, open the file there in `$EDITOR` or `$VISUAL`, wait for the editor to exit, validate with the loader, and respawn the picker at the compact size. `beside`, `below`, and `tab` MUST open the editor in a managed plugin pane at that placement, validate on exit, and close that pane without reopening the picker. When there is no selected valid workflow, `o` MUST NOT launch an editor action.

#### Scenario: Open repo workflow
- **WHEN** repo workflow `deploy` is selected and the user presses `Ctrl+K` then `o` then confirms `popup`
- **THEN** the picker respawns at the console size, opens that file in the editor inside the popup, validates on exit, and respawns compact

#### Scenario: Open in a new tab
- **WHEN** the user confirms `tab` for the selected workflow
- **THEN** the editor opens in a managed pane in a new tab, and the picker closes without reopening

#### Scenario: Open without selection
- **WHEN** the filtered list has no selected workflow and the user presses `Ctrl+K` then `o`
- **THEN** the picker does not launch an editor action
