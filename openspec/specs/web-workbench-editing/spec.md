# web-workbench-editing Specification

## Purpose
Reliable, accessible workflow editing across YAML and canvas modes in the web workbench.

## Requirements
### Requirement: Workflow save state reflects the saved baseline
The workbench MUST consider a workflow unsaved when its name, selected scope, or YAML content differs from the last successfully saved file. It MUST display an unsaved-state indicator and the Save action only while unsaved. Returning every value to the saved baseline MUST restore the clean state and hide Save. A filesystem operation the workbench cannot complete MUST be reported as a failure rather than as success.

#### Scenario: Content becomes dirty
- **WHEN** a user changes workflow YAML or canvas content
- **THEN** the workbench displays the unsaved indicator and Save action

#### Scenario: Edit returns to baseline
- **WHEN** undo restores the saved name, scope, and content
- **THEN** the unsaved indicator and Save action disappear

#### Scenario: Save fails
- **WHEN** persistence or validation fails
- **THEN** the workflow remains unsaved and the original file remains intact

#### Scenario: Delete fails
- **WHEN** the workbench cannot remove a workflow file
- **THEN** the failure is reported and the workflow is not presented as deleted

### Requirement: Scope changes are applied by explicit save
The workflow scope selector MUST mark a changed scope as unsaved and MUST NOT move a workflow immediately. A successful Save MUST apply a rename or re-scope as a single request that claims the destination and removes the original source. Save MUST NOT overwrite any path other than the one the buffer was loaded from, and a save that cannot complete MUST leave the filesystem unchanged. The editor MUST NOT provide a separate move-to-scope action.

#### Scenario: Scope selection changes
- **WHEN** a user changes a workflow from global to local
- **THEN** Save appears and no file is moved before Save is activated

#### Scenario: Destination write succeeds
- **WHEN** a changed scope is saved successfully
- **THEN** the selected destination contains the workflow and the original source is removed

#### Scenario: Rename, re-scope, or new workflow collides
- **WHEN** Save would write to a path that already exists and is not the path the buffer was loaded from
- **THEN** the workbench rejects the save, leaves the destination unchanged, and keeps the original source

#### Scenario: Concurrent saves claim the same destination
- **WHEN** two saves target the same previously absent destination
- **THEN** exactly one succeeds and the other is rejected as a collision

#### Scenario: Source removal fails
- **WHEN** a rename or re-scope claims its destination but cannot remove the original source
- **THEN** the destination claim is undone, the workflow stays unsaved, no success toast is shown, and only the original source remains on disk

#### Scenario: Undoing the destination claim also fails
- **WHEN** the source cannot be removed and the claimed destination cannot be undone either
- **THEN** the reported failure names the copy left behind so the collision it will cause is explained, and the workbench refreshes its workflow list because that copy is now on disk

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
