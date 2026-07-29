## ADDED Requirements

### Requirement: Input prompts state what they collect
An input prompt MUST render the input name, the author description when one is declared, and how the
value is supplied. It MUST render the prompt's ordinal position, counted over the inputs already
answered in the current collection. For a resolved closed domain it MUST report the number of
available options; for a domain that is not yet resolved it MUST NOT state a count. It MUST report
when a value outside the listed options is accepted, and MUST report a text input's default and its
minimum length when either is declared. The prompt MUST NOT change the workflow title row, the list
viewport, or the footer key hints.

#### Scenario: Dropdown of many options
- **WHEN** a choice input resolves to sixty-seven options
- **THEN** the prompt names the input, shows its description, and reports that one of sixty-seven is
  to be picked

#### Scenario: Undescribed input
- **WHEN** an input declares no description
- **THEN** the prompt still reports the input name, its ordinal position, and how to supply a value

#### Scenario: Custom value accepted
- **WHEN** a choice input sets `allow_custom: true`
- **THEN** the prompt reports that a value outside the listed options may be typed

#### Scenario: Constrained text input
- **WHEN** a text input declares a default and a minimum length
- **THEN** the prompt reports both alongside the free-text instruction

#### Scenario: Unresolved dynamic domain
- **WHEN** a dynamic choice has not resolved its options
- **THEN** the prompt asks for a selection without claiming a count

### Requirement: Collected answers stay visible during collection
While collecting inputs, the picker MUST render the answers already collected, in declaration order,
as name and value pairs below the prompt. It MUST omit that line before the first answer, and MUST
truncate it to the content width. The line MUST reflect discarded answers after a backward
navigation.

#### Scenario: A guarded domain is explained by an earlier answer
- **WHEN** a user answers `mode` with `delete` and reaches the guarded `worktree` prompt
- **THEN** the prompt area shows that `mode` is `delete`

#### Scenario: First prompt has no answers
- **WHEN** the first active input is presented
- **THEN** no collected-answer line is rendered

#### Scenario: Answers exceed the popup width
- **WHEN** the collected answers are longer than the content width
- **THEN** the line is truncated with an ellipsis and the layout does not shift

#### Scenario: Backward navigation drops later answers
- **WHEN** a user navigates back to `mode` and changes it, discarding later answers
- **THEN** the collected-answer line no longer lists the discarded inputs
