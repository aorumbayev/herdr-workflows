## ADDED Requirements

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
