## ADDED Requirements

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
