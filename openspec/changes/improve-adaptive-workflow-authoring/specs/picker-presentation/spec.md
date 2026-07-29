## ADDED Requirements

### Requirement: Input navigation preserves valid answers
Escape from an input prompt MUST move to the previous active input and restore its collected value. Escape from the first active input MUST return to the workflow list. Changing an earlier value MUST discard all later answers and resolved dynamic-choice domains before active inputs are recalculated. Returning to the list MUST clear the collection. Escape and Enter after a terminal run failure MUST both dismiss with a nonzero status.

#### Scenario: Correct the final answer
- **WHEN** a user presses Escape on the last of three active inputs
- **THEN** the picker returns to the second input and preserves the first input's answer

#### Scenario: Mode change alters active inputs
- **WHEN** a user navigates back, changes `mode` from `create` to `delete`, and continues
- **THEN** later create-only answers are discarded and only delete-active inputs are collected

#### Scenario: Failed run dismissal
- **WHEN** a run has failed and the user presses Escape
- **THEN** the picker exits nonzero just as it does when the user presses Enter
