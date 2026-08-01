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

### Requirement: Workbench-written workflows carry a build-pinned schema pointer
A workflow the workbench writes MUST begin with a schema pointer that resolves to the workflow contract this build implements, and MUST NOT reference a ref whose content can change independently of the build. A pointer already present MUST be replaced wherever it appears rather than duplicated. The rest of the text, including the format version line and the author's formatting, MUST be preserved, and the save baseline the workbench reports MUST identify the bytes written. Resolving the pointer MUST NOT require a network call at save time.

#### Scenario: No schema pointer present
- **WHEN** the workbench saves workflow text carrying no schema pointer
- **THEN** the written file begins with a pointer to this build's contract and the remainder of the text is unchanged

#### Scenario: Pointer names another build's contract
- **WHEN** the workbench saves workflow text whose schema pointer references a different ref, on the first line or below it
- **THEN** that pointer is replaced with this build's pointer and the file carries exactly one

#### Scenario: Pointer already correct
- **WHEN** the workbench saves workflow text already pinned to this build's contract
- **THEN** the written bytes are identical to the submitted text

#### Scenario: Saving normalized text again
- **WHEN** a save adds or replaces the pointer and the editor saves again from the baseline that save reported
- **THEN** the second save is accepted rather than rejected as stale

### Requirement: Scope changes are applied by explicit save
The workflow scope selector MUST mark a changed scope as unsaved and MUST NOT move a workflow immediately. A successful Save MUST apply a rename or re-scope as a single request that claims the destination and removes the original source. A save MUST NOT destroy content the buffer was not derived from: it MUST replace only content that still matches what the editor loaded, and MUST otherwise be rejected as stale, naming the conflict and leaving the file as the other writer left it. An in-place save MUST acquire an exclusive adjacent claim, recheck the submitted baseline while holding that claim, and replace the file through a same-directory temporary write and atomic rename so concurrent baselines cannot both succeed. The workbench MUST refuse to edit a symlinked workflow file or workflow root, and MUST resolve paths and keep them inside the selected workflow root. A save that cannot complete MUST leave the filesystem unchanged. The editor MUST NOT provide a separate move-to-scope action.

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

#### Scenario: Concurrent in-place saves share one baseline
- **WHEN** two saves target the path their buffers were loaded from and carry the same baseline
- **THEN** exactly one succeeds and the other is rejected as a conflict, and the winning writer's bytes remain on disk

#### Scenario: The loaded file changed underneath the editor
- **WHEN** a save targets the path its buffer was loaded from and that file's content has changed since it was loaded, whether by another workbench tab, an import, or a checkout
- **THEN** the save is rejected as stale, the other writer's content is left in place, and the editor keeps the unsaved buffer

#### Scenario: Save cannot identify what it would replace
- **WHEN** a save targets the path its buffer was loaded from but carries no record of the content it loaded
- **THEN** the save is rejected rather than overwriting the file unseen

#### Scenario: Symlinked workflow or workflow root
- **WHEN** a save would write a workflow file or workflow root that is a symbolic link, or whose resolved path leaves the selected workflow root
- **THEN** the workbench rejects the save and leaves any symlink target unchanged

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
whose fields are all unset MUST collapse to a single line summarizing its state, and MUST expand on
demand. Every field the form renders MUST belong to exactly one section, and a field the page has no
section assignment for MUST appear in a trailing section rather than be omitted.

#### Scenario: Unset section collapses

- **WHEN** a step sets no failure-handling field
- **THEN** that section shows a one-line summary instead of its fields, and expands when activated

#### Scenario: Set section summarizes its values

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
Copy, download, share (when the workflow has a saved name), and delete MUST be presented in a single overflow menu in the editor command bar rather than as peer buttons beside Save. The menu MUST open from a control with an accessible name, MUST be operable by keyboard, and MUST close on Escape or on activating an item. Delete MUST keep its confirmation and, when the workflow name exists in both scopes, MUST still let the user choose which variant to remove. The yaml-mode step-append actions MUST likewise be presented as one menu rather than one button per verb.

#### Scenario: Secondary actions are one control
- **WHEN** a workflow is open
- **THEN** the command bar shows Save and a single overflow control, and copy, download, share (when named), and delete appear only inside that menu

#### Scenario: Keyboard operation
- **WHEN** a keyboard user opens the overflow menu
- **THEN** focus moves into the menu, each item is reachable and activatable, and Escape closes it and returns focus to the control that opened it

#### Scenario: Delete still confirms
- **WHEN** a user chooses delete from the menu
- **THEN** the deletion is confirmed before any request is sent

#### Scenario: Both scope variants exist
- **WHEN** the open workflow's name exists in both the repo and the global scope
- **THEN** the menu still offers the choice of removing the local, the global, or both variants

### Requirement: New-workflow deep link opens a blank unsaved editor
When the workbench opens with hash `#new` (route `new`), it MUST present the same blank unsaved editor seed as the in-page New control: empty name, repo scope, and the default starter YAML including this build's schema pointer when available. It MUST NOT load or overwrite an existing workflow file until the user saves under a chosen name.

#### Scenario: Hash new
- **WHEN** the workbench loads with `#new`
- **THEN** the editor shows an unsaved new workflow with the starter YAML and no existing file path

### Requirement: YAML key autocomplete derives from the served schema
YAML key autocomplete in the workbench editor MUST offer top-level and step keys from the workflow JSON Schema the server derives from the loader's Zod schema. It MUST NOT maintain a separate key list that can omit a key the served schema describes. A key such as `success_codes` that the schema accepts on a step MUST appear among step-key suggestions once the schema is loaded.

#### Scenario: Step key present in the served schema
- **WHEN** the served schema describes `success_codes` on a step
- **THEN** step-key autocomplete includes `success_codes`

#### Scenario: Top-level keys follow the served schema
- **WHEN** the served schema lists top-level workflow properties
- **THEN** top-level key autocomplete offers exactly those property names

### Requirement: Live validation reports domain sensitivity labels
The workbench validate endpoint MUST return sensitivity labels from the same domain analysis used for workflow listing, workflow load, and bundle preview, including unresolved child references when analysis can parse the document. The editor MUST present those labels and MUST NOT recompute command, transcript, or sensitive-Herdr-method detection with browser-side heuristics.

#### Scenario: Validate matches workflow load
- **WHEN** the editor validates YAML that a workflow GET would flag as sensitive
- **THEN** the validate response carries the same sensitivity labels

#### Scenario: Unresolved child is reported
- **WHEN** validated YAML references a child workflow that cannot be resolved
- **THEN** the labels include an unresolved entry for that child name

### Requirement: Authenticated JSON responses are not stored by caches
Authenticated workbench JSON API responses MUST include `Cache-Control: no-store`. Public static assets such as the favicon MAY remain cacheable.

#### Scenario: Authenticated API response
- **WHEN** a client with a valid token requests an authenticated JSON endpoint
- **THEN** the response includes `Cache-Control: no-store`

#### Scenario: Public static asset
- **WHEN** a client requests the workbench favicon
- **THEN** the response MAY advertise a public cache lifetime


