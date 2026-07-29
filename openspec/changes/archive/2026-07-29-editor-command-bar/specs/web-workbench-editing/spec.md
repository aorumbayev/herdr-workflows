## ADDED Requirements

### Requirement: Secondary and destructive actions live in an overflow menu
Copy, download, and delete MUST be presented in a single overflow menu in the editor command bar rather than as peer buttons beside Save. The menu MUST open from a control with an accessible name, MUST be operable by keyboard, and MUST close on Escape or on activating an item. Delete MUST keep its confirmation and, when the workflow name exists in both scopes, MUST still let the user choose which variant to remove. The yaml-mode step-append actions MUST likewise be presented as one menu rather than one button per verb.

#### Scenario: Secondary actions are one control
- **WHEN** a workflow is open
- **THEN** the command bar shows Save and a single overflow control, and copy, download, and delete appear only inside that menu

#### Scenario: Keyboard operation
- **WHEN** a keyboard user opens the overflow menu
- **THEN** focus moves into the menu, each item is reachable and activatable, and Escape closes it and returns focus to the control that opened it

#### Scenario: Delete still confirms
- **WHEN** a user chooses delete from the menu
- **THEN** the deletion is confirmed before any request is sent

#### Scenario: Both scope variants exist
- **WHEN** the open workflow's name exists in both the repo and the global scope
- **THEN** the menu still offers the choice of removing the local, the global, or both variants
