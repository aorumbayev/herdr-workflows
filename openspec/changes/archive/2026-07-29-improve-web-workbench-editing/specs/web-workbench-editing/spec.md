## ADDED Requirements

### Requirement: Workflow save state reflects the saved baseline
The workbench MUST consider a workflow unsaved when its name, selected scope, or YAML content differs from the last successfully saved file. It MUST display an unsaved-state indicator and the Save action only while unsaved. Returning every value to the saved baseline MUST restore the clean state and hide Save.

#### Scenario: Content becomes dirty
- **WHEN** a user changes workflow YAML or canvas content
- **THEN** the workbench displays the unsaved indicator and Save action

#### Scenario: Edit returns to baseline
- **WHEN** undo restores the saved name, scope, and content
- **THEN** the unsaved indicator and Save action disappear

#### Scenario: Save fails
- **WHEN** persistence or validation fails
- **THEN** the workflow remains unsaved and the original file remains intact

### Requirement: Scope changes are applied by explicit save
The workflow scope selector MUST mark a changed scope as unsaved and MUST NOT move a workflow immediately. A successful Save MUST write the selected destination before removing the original source. The editor MUST NOT provide a separate move-to-scope action.

#### Scenario: Scope selection changes
- **WHEN** a user changes a workflow from global to local
- **THEN** Save appears and no file is moved before Save is activated

#### Scenario: Destination write succeeds
- **WHEN** a changed scope is saved successfully
- **THEN** the selected destination contains the workflow and the original source is removed

#### Scenario: Both scope variants exist
- **WHEN** local and global workflows already share the edited name
- **THEN** the scope selector is unavailable so saving cannot overwrite either variant

### Requirement: History controls follow the active editor mode
The editor MUST expose Undo and Redo controls in both YAML and canvas modes. YAML history MUST use the text editor's native editing history. Canvas history MUST cover additions, removals, reordering, movement, and form changes, MUST retain at most forty prior states, and MUST clear redo after a new mutation.

#### Scenario: YAML history
- **WHEN** the YAML editor is active and the user activates Undo or Redo
- **THEN** the corresponding native text history operation is applied

#### Scenario: Canvas undo and redo
- **WHEN** a user undoes and then redoes a canvas mutation
- **THEN** the canvas and shared YAML buffer return to the respective prior and subsequent states

#### Scenario: Divergent canvas edit
- **WHEN** a user undoes a canvas mutation and then makes a new mutation
- **THEN** the prior redo history is unavailable

### Requirement: Canvas can fill the browser viewport
The canvas MUST provide an expanded view that fills the browser viewport without invoking the browser Fullscreen API. All canvas editing controls MUST remain available. The view MUST exit from its toggle or Escape, restore document scrolling, and return focus to the expansion control.

#### Scenario: Expand and exit
- **WHEN** a user expands the canvas and presses Escape
- **THEN** the normal workbench layout and document scrolling are restored and focus returns to the expansion control

### Requirement: Visual editing preserves valid recovery YAML
Switching from canvas to YAML MUST serialize supported workflow metadata and steps as valid workflow YAML. Recovery actions with multiple or nested fields MUST remain mappings with sibling fields at the correct indentation.

#### Scenario: Recovery action with parameters
- **WHEN** a workflow containing `on_failure.herdr` and nested `on_failure.params` enters canvas mode and returns to YAML mode
- **THEN** the formatted YAML reparses successfully and preserves the recovery method and parameters
