## ADDED Requirements

### Requirement: ratatui picker popup
The `picker` entry mode SHALL render the workflow picker as a ratatui (crossterm backend) application in the herdr popup pane, replacing OpenTUI. It SHALL require a TTY and SHALL restore the terminal state on exit, including on panic.

#### Scenario: Terminal restored on panic
- **WHEN** the picker panics during rendering or event handling
- **THEN** raw mode is disabled and the alternate screen is left before the process exits

### Requirement: Picker modes
The picker SHALL support the modes `list`, `input`, `prompt`, `run`, and `confirm` with the same transitions as the TypeScript picker: list → (confirm when gated) → per-declared-input screens → optional prompt screen → run screen.

#### Scenario: Input screens follow declared inputs
- **WHEN** a workflow declares two inputs and is selected
- **THEN** the picker presents one input screen per declared input, then the prompt screen, before running

### Requirement: Substring filter and row rendering
The list mode SHALL filter workflow rows by case-insensitive substring match on typed text. Each row SHALL show name, source, and input/prompt markers; workflows that fail validation SHALL appear dimmed with a truncated error and SHALL NOT be runnable.

#### Scenario: Invalid workflow dimmed and blocked
- **WHEN** a workflow file fails validation
- **THEN** its row is rendered dimmed with a truncated load error and pressing enter on it does not start a run

### Requirement: Confirm gate
The picker SHALL require an explicit confirm step before running a workflow that is repo-owned or declares dynamic (command-backed) options, because such workflows may run shell commands from the repository.

#### Scenario: Repo workflow requires confirmation
- **WHEN** a workflow with `source: repo` is selected
- **THEN** a confirm screen is shown before any input collection or execution

### Requirement: Run screen and exit codes
The run screen SHALL stream `[i/n] label` step progress as the workflow executes. On success the picker SHALL exit with code 0; on failure it SHALL display `Failed · <error>` and exit with code 1 on the next keypress.

#### Scenario: Failure shows error and exits 1
- **WHEN** a step fails during a picker-initiated run
- **THEN** the run screen shows `Failed · <error>` and the process exits 1 after a keypress

### Requirement: Simplified theme
The picker SHALL style selection using terminal default colors with reverse video. It SHALL NOT query the terminal palette (OSC 4/10/11) and SHALL NOT compute WCAG contrast ratios.

#### Scenario: No palette queries
- **WHEN** the picker starts
- **THEN** no OSC palette query sequences are written to the terminal

### Requirement: Keybindings
The picker SHALL support arrow-up/arrow-down (or equivalent) to move selection, enter to accept, and escape to go back or exit, in every mode, matching the TypeScript picker's key map.

#### Scenario: Escape backs out of input mode
- **WHEN** escape is pressed on an input screen
- **THEN** the picker returns to the list mode without running the workflow
