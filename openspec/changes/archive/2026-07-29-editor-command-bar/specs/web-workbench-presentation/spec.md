## ADDED Requirements

### Requirement: Editor chrome occupies a single command bar
The workflow editor MUST present its document chrome as one horizontal bar above the editing surface: workflow identity (name, scope, and the sensitivity chip) leading, and controls (mode toggle, history, unsaved text, save, and an overflow menu of secondary actions) trailing. The editor MUST NOT render a sensitivity banner, a validity line, or a terminal-command footer as separate full-width bands. The workflow's run command MUST remain visible on the canvas trigger caption, and MUST NOT be repeated elsewhere in the editor. When the bar cannot fit its controls on one line, controls MUST fold into the overflow menu rather than being dropped.

#### Scenario: One band of chrome
- **WHEN** a workflow is open in either yaml or canvas mode
- **THEN** exactly one control bar renders above the editing surface, and no sensitivity banner, validity line, or terminal-command footer renders as its own band

#### Scenario: Sensitivity is a chip
- **WHEN** a workflow resolves to one or more sensitivity labels
- **THEN** those labels render as a chip beside the workflow name, and the chip is absent when there are none

#### Scenario: The run command appears once
- **WHEN** the workflow name changes
- **THEN** the canvas trigger caption states the updated `hwf run <name>` command and no other element in the editor repeats it

#### Scenario: Narrow viewport
- **WHEN** the viewport is too narrow for the bar's controls
- **THEN** every control remains reachable, with the folded ones available from the overflow menu

### Requirement: Canvas view controls live on the canvas
Canvas view controls MUST occupy two clusters inside the canvas: zoom out, a zoom-level readout, and zoom in in one cluster; add step, fit, expand, and a shortcuts toggle in the other. The readout MUST state the current zoom level as a percentage and MUST reset the zoom to 1:1 when activated. No canvas control MUST render as a free-floating box outside those clusters. Each control MUST carry an accessible name, a visible `:focus-visible` ring, hover and active states, and a hit target of at least 32px in the smaller dimension.

#### Scenario: Zoom readout doubles as reset
- **WHEN** a user zooms in and then activates the zoom readout
- **THEN** the readout reported the zoom level as a percentage beforehand and the canvas returns to 1:1

#### Scenario: Controls stay available while expanded
- **WHEN** the canvas is expanded to fill the viewport
- **THEN** both clusters remain on the canvas, so add step, zoom, fit, exit, and shortcuts are all still reachable

#### Scenario: Keyboard reach
- **WHEN** a keyboard user tabs into the canvas clusters
- **THEN** each control shows a focus ring and exposes its action by accessible name

### Requirement: Keyboard shortcut help is disclosed, not permanent
The canvas MUST NOT print its keyboard hint text over the graph at all times. The hint text MUST be reachable from a shortcuts toggle in the canvas view cluster, MUST report its expanded state to assistive technology, and MUST dismiss from the same toggle or Escape.

#### Scenario: Hint hidden by default
- **WHEN** the canvas first renders
- **THEN** no keyboard hint text overlays the graph and the shortcuts toggle reports itself collapsed

#### Scenario: Hint on demand
- **WHEN** a user activates the shortcuts toggle
- **THEN** the hint text appears, the toggle reports itself expanded, and Escape or a second activation dismisses it

### Requirement: The workbench layout adapts to narrow viewports
The page MUST remain usable at phone widths. Below a narrow-viewport breakpoint the workflow list and the editor MUST stack in a single column instead of sharing a two-column grid, the list MUST become a horizontally scrollable strip of fixed-width entries, and the command bar MUST break between its identity group and its control group rather than clipping either. The canvas MUST keep a usable height at those widths, and canvas control clusters MUST NOT overlap each other. Controls anchored to a viewport edge MUST respect the device safe-area insets.

#### Scenario: Phone-width layout
- **WHEN** the viewport is narrower than the breakpoint
- **THEN** the list and editor stack in one column, the list scrolls horizontally, and the command bar splits into an identity line and a control line

#### Scenario: Every control still reachable
- **WHEN** a user works at phone width
- **THEN** the mode toggle, save, the overflow menu, and both canvas clusters are all present and operable, with history reachable from the overflow menu

#### Scenario: Safe-area insets
- **WHEN** the page renders on a display with insets
- **THEN** edge-anchored canvas controls sit inside the safe area

### Requirement: The workflow list can be collapsed
The header MUST provide a single control that hides and shows the workflow list, available only while the workflows tab is showing a workflow rather than a share or import view. The control MUST state which action it performs, expose its expanded state to assistive technology, and be keyboard reachable. Opening or creating a workflow on a narrow viewport MUST collapse the list so the editor gets the width.

#### Scenario: Collapse and restore
- **WHEN** a user activates the list control
- **THEN** the list is hidden, the editor spans the full width, and the control now offers to show the list again

#### Scenario: State is exposed
- **WHEN** the control receives keyboard focus
- **THEN** it shows a focus ring and its accessible name and expanded state describe the list's current visibility

#### Scenario: Narrow viewport opens straight into the editor
- **WHEN** a user opens or creates a workflow on a narrow viewport
- **THEN** the list collapses so the editor is what fills the screen

#### Scenario: Not offered where it does not apply
- **WHEN** the config tab, the runs tab, or a share or import view is showing
- **THEN** the list control is absent

## MODIFIED Requirements

### Requirement: Editing state and canvas view controls are accessible
Undo, Redo, Save, the secondary-action overflow menu and its items, and canvas expansion controls MUST have accessible names, visible focus states, hover and active states, and a hit target of at least 32px in the smaller dimension. The unsaved-state indicator MUST be exposed as text rather than color alone. The validity indicator MUST likewise pair any color cue with text: a problem MUST render its message as text, and MUST NOT be signalled by color alone.

#### Scenario: Keyboard navigation
- **WHEN** a keyboard user traverses workflow editor actions
- **THEN** each available history, save, overflow, and expansion control receives a visible focus ring and exposes its action by accessible name

#### Scenario: Unsaved state without color perception
- **WHEN** a workflow differs from its saved baseline
- **THEN** the interface displays text identifying unsaved changes in addition to any color cue

#### Scenario: Invalid state without color perception
- **WHEN** a workflow fails validation
- **THEN** the failure message renders as text alongside any color cue, and remains available without hovering or focusing a control
