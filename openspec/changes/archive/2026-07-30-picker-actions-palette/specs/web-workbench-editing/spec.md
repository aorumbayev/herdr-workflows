## ADDED Requirements

### Requirement: New-workflow deep link opens a blank unsaved editor
When the workbench opens with hash `#new` (route `new`), it MUST present the same blank unsaved editor seed as the in-page "+ new" control: empty name, repo scope, and the default starter YAML including this build's schema pointer when available. It MUST NOT load or overwrite an existing workflow file until the user saves under a chosen name.

#### Scenario: Hash new
- **WHEN** the workbench loads with `#new`
- **THEN** the editor shows an unsaved new workflow with the starter YAML and no existing file path
