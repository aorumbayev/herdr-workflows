## ADDED Requirements

### Requirement: Default workflows view exposes import and share
The workflows list in the default workbench view MUST provide an Import control that opens the same import route UI as `#import`, without requiring a picker deep link. When a saved workflow (non-empty name) is open in the editor, the workbench MUST provide a Share control that opens the same share route UI as `#share=<scope>:<name>` for that workflow's current scope. These controls MUST be keyboard reachable with the same baseline affordances as other workbench buttons.

#### Scenario: Import from the list
- **WHEN** a user activates Import in the workflows list
- **THEN** the import review UI opens at `#import`

#### Scenario: Share from the editor
- **WHEN** a user has saved workflow `deploy` open from the repo scope and activates Share
- **THEN** the share UI opens for `repo:deploy`

#### Scenario: New unsaved workflow has no share
- **WHEN** the blank new-workflow editor is open with an empty name
- **THEN** Share is not offered until the workflow has a saved name
