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

### Requirement: Node form fields derive from the workflow schema

The node parameters form MUST build its fields from the workflow JSON Schema the server derives from
the loader's Zod schema, not from a field list maintained inside the page. A field's widget and its
accepted values MUST come from that schema: an enumerated string as a closed selection, a boolean as
a checkbox, a bounded integer as a numeric entry carrying the schema's bounds, a mapping of strings as
key/value entries, and a nested object as its own group of fields. The page MUST NOT restate any
bound, pattern, or enumeration the schema already states. A schema key the page has no presentation
entry for MUST still render with a widget chosen from its type, so a schema addition appears in the
form without a page change. A key the served schema does not describe MUST be preserved untouched and
reported as carried over from YAML.

#### Scenario: Enumerated key renders as a closed selection

- **WHEN** the served schema describes `shell` as an enumeration
- **THEN** the form offers exactly those values as a selection rather than free text

#### Scenario: Bounded integer carries schema bounds

- **WHEN** the served schema bounds `pane.size` between 1 and 99
- **THEN** the form rejects a value outside that range without the page restating the range

#### Scenario: Schema gains a key the page does not describe

- **WHEN** the served schema describes a step key that has no presentation entry in the page
- **THEN** the form renders an editable field for that key from its schema type

#### Scenario: Key absent from the served schema

- **WHEN** a loaded step carries a key the served schema does not describe
- **THEN** the form preserves the key's value unchanged and reports it as carried over from YAML

### Requirement: Node form fields are grouped by authoring intent

The node parameters form MUST present fields in named sections ordered by the question the author is
answering: what the step does, where it runs, when it runs, and what happens if it fails. A section
whose fields are all unset MUST collapse to a single line summarising its state, and MUST expand on
demand. Every field the form renders MUST belong to exactly one section, and a field the page has no
section assignment for MUST appear in a trailing section rather than be omitted.

#### Scenario: Unset section collapses

- **WHEN** a step sets no failure-handling field
- **THEN** that section shows a one-line summary instead of its fields, and expands when activated

#### Scenario: Set section summarises its values

- **WHEN** a step sets a timeout and a retry
- **THEN** the failure-handling section's summary states those values

#### Scenario: Field without a section assignment

- **WHEN** the form renders a field the page assigns to no section
- **THEN** the field appears in the trailing section

### Requirement: Structured step values are edited as typed fields

The node parameters form MUST NOT require an author to write JSON for a value the schema describes
structurally. A retry MUST be edited as its attempt count and its delay. A string mapping MUST be
edited as key/value rows. A value the schema accepts as either a string or a list of strings MUST
offer an explicit choice between the two forms, and MUST accept the list form as one element per line
rather than as JSON array text. The form MAY fall back to JSON entry only where the schema accepts
values of unconstrained shape.

#### Scenario: Retry is edited as two fields

- **WHEN** an author opens a step that supports retry
- **THEN** the form offers an attempt count honouring the schema minimum and a separate delay entry

#### Scenario: Command list is edited as lines

- **WHEN** an author selects the list form of `run:`
- **THEN** each line of the entry becomes one argument, with no JSON quoting required

#### Scenario: Environment is edited as rows

- **WHEN** an author adds an environment variable
- **THEN** the form provides a name entry and a value entry rather than JSON object text

### Requirement: Herdr steps are authored from the generated method table

The node parameters form MUST offer `herdr:` methods from the generated method table rather than as
free text. A method the table marks as not allowed MUST be presented as unavailable together with the
invariant it protects. The parameters of the selected method MUST be presented from that method's
parameter specification, marking required parameters, offering enumerated parameters as closed
selections, and choosing each remaining widget from the parameter's kind. A JSON entry MUST remain
available only for a method whose specification accepts additional properties.

#### Scenario: Method selection

- **WHEN** an author opens a herdr step
- **THEN** the form offers the generated method names as a selection

#### Scenario: Denied method

- **WHEN** the generated table marks a method as not allowed
- **THEN** the form presents it as unavailable and states the reason the table records

#### Scenario: Method parameters

- **WHEN** an author selects a method whose specification requires named parameters
- **THEN** the form renders a field per parameter, marks the required ones, and offers enumerated
  parameters as closed selections

### Requirement: Validation issues report on the field they name

The workbench MUST report a loader validation issue on the field the issue names. The validation
response MUST carry each issue's path alongside its message, and the form MUST place the loader's
message on the addressed field, mark the containing section, and mark the step on the canvas. An issue
the form cannot address to a field MUST still be reported in the editor's status area. The page MUST
NOT restate any cross-field rule the loader enforces, and MUST NOT hide or disable a field to
anticipate one.

#### Scenario: Issue addressed to a field

- **WHEN** the loader rejects a step because a background step sets a retry
- **THEN** the loader's message appears on the retry field, its section is marked, and the step is
  marked on the canvas

#### Scenario: Issue that names no form field

- **WHEN** the loader reports an issue the form cannot address to a rendered field
- **THEN** the message appears in the editor's status area

#### Scenario: Rule the form does not anticipate

- **WHEN** a combination the loader rejects is available in the form
- **THEN** the form still offers both fields and reports the loader's message once validation runs

### Requirement: Entered field values reach validation

The node parameters form MUST submit every value it accepted from the author for validation, and MUST
NOT discard a value because a sibling field is unset. A group whose required key is unset MUST be
reported by the loader rather than silently dropped by the form.

#### Scenario: Sibling key unset

- **WHEN** an author fills placement fields while leaving the group's required key unset
- **THEN** the entered values are submitted and the loader's message about the missing key is
  reported, with no entered value discarded

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

