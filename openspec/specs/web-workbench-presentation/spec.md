# web-workbench-presentation Specification

## Purpose
Nord-themed, WCAG-AA, syntax-highlighted web workbench presentation for herdr-workflows.
## Requirements
### Requirement: Palette is expressed as named Nord tokens
The served workbench page MUST define the sixteen Nord palette colors as named custom properties on `:root`. Semantic color variables (surfaces, ink, lines, accents, node colors, syntax token colors) MUST live only in the dark and light theme token blocks. Component rules outside those blocks MUST NOT hardcode a color literal.

#### Scenario: Semantic variables live in token blocks
- **WHEN** the served page CSS is inspected
- **THEN** every color literal appears inside the `:root` or `:root[data-theme="light"]` token blocks

#### Scenario: Component rules use semantic variables
- **WHEN** a header, list, or pane rule sets a color
- **THEN** it references a semantic custom property rather than an inline `rgb()` or hex literal

### Requirement: Page supports dark and light Nord themes
The page MUST provide a dark theme (Nord Polar Night surfaces) and a light theme (Nord Light: Snow Storm surfaces, Polar Night ink, Frost accents). The page MUST express the light theme only as a token override block scoped to the active-theme selector, so no component rule repeats per theme. The `color-scheme` property MUST match the active theme. Light-theme accents and syntax tokens MUST keep Nord hue identity while meeting WCAG AA on Snow Storm surfaces.

#### Scenario: Light theme active
- **WHEN** the light theme is active
- **THEN** page surfaces use Snow Storm tokens, body text uses Polar Night ink, and `color-scheme` is `light`

#### Scenario: No duplicated component rules
- **WHEN** the light theme token block is present
- **THEN** the only theme-conditional CSS is that token override block

### Requirement: Theme selection is user-controlled and persisted
The header MUST contain a single labeled theme control that cycles three states: follow system, dark, light. The selected state MUST persist across reloads in `localStorage`. With no stored selection, the page MUST follow `prefers-color-scheme` and react to system changes live. The control MUST be keyboard reachable and MUST expose its current state to assistive technology.

#### Scenario: Explicit choice persists
- **WHEN** a user selects light and reloads the page
- **THEN** the page renders light without a dark flash

#### Scenario: Follow system
- **WHEN** no selection is stored and the OS reports a light preference
- **THEN** the page renders light, and switching the OS to dark re-renders dark without a reload

#### Scenario: Keyboard and assistive access
- **WHEN** the control receives keyboard focus
- **THEN** it shows a focus-visible ring, activates via Enter/Space, and its accessible name states the active theme

### Requirement: Every YAML surface is syntax highlighted
Every surface in the page that displays workflow YAML — the editor, the share bundle review, the import bundle review, and any read-only YAML block — MUST render it through the page's YAML highlighter. No render path MUST render YAML as unhighlighted text. All YAML rendering MUST go through one shared helper, and the highlighted output MUST be escaped so YAML content cannot inject markup.

#### Scenario: Share bundle review
- **WHEN** a user opens sharing for a workflow with children
- **THEN** each bundle entry's YAML renders with key, verb, string, number, comment, block-scalar and placeholder tokens colored

#### Scenario: Import bundle review
- **WHEN** a user pastes an import bundle
- **THEN** each reviewed entry's YAML renders highlighted before any destination is chosen

#### Scenario: Untrusted YAML content
- **WHEN** an entry's YAML contains `<script>` or other markup
- **THEN** it renders as literal escaped text, not as page markup

#### Scenario: Highlighting is enforced, not advised
- **WHEN** a render path assigns YAML to a block without the shared helper
- **THEN** the test suite fails

### Requirement: Interactive elements have baseline affordances in both themes
All interactive elements — buttons, tabs, nodes, selects, inputs, links, and the theme control — MUST show a visible `:focus-visible` ring, a distinct hover state, and a distinct active/selected state. Each MUST present a hit target of at least 32px in the smaller dimension. Body text, muted text, and syntax token colors MUST meet WCAG AA contrast against their surface in both themes.

#### Scenario: Keyboard traversal
- **WHEN** a user tabs through the header, list and pane
- **THEN** every focused element shows a ring meeting contrast against its surface in the active theme

#### Scenario: Muted text contrast
- **WHEN** muted text or a syntax token renders in either theme
- **THEN** its contrast against the surface is at least 4.5:1

### Requirement: Canvas structure is visually distinct in both themes
The canvas MUST use semantic theme tokens to distinguish its background, workflow nodes, node borders, ports, and connecting edges in dark and light themes. Nodes MUST appear elevated from the canvas and connecting edges MUST remain readily visible without adding redundant action-type color rails. Component rules MUST continue to contain no color literals.

#### Scenario: Dark canvas hierarchy
- **WHEN** the dark theme canvas displays a workflow
- **THEN** node surfaces and borders are distinct from the canvas and edges remain visible between nodes

#### Scenario: Light canvas hierarchy
- **WHEN** the light theme canvas displays a workflow
- **THEN** the same structural hierarchy remains visible using light-theme semantic token overrides

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
Canvas view controls MUST occupy two clusters inside the canvas: zoom out, a zoom-level readout, and zoom in in one cluster. Add step, fit, expand, and a shortcuts toggle in the other. The readout MUST state the current zoom level as a percentage and MUST reset the zoom to 1:1 when activated. No canvas control MUST render as a free-floating box outside those clusters. Each control MUST carry an accessible name, a visible `:focus-visible` ring, hover and active states, and a hit target of at least 32px in the smaller dimension.

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
The workflow list chrome MUST provide a control that hides the list, available only while the workflows tab is showing a workflow rather than a share or import view. When the list is hidden, a restore control MUST appear as a rail beside the editor (not in the page header). Each control MUST state which action it performs, expose the list's expanded state to assistive technology, and be keyboard reachable. Opening or creating a workflow on a narrow viewport MUST collapse the list so the editor gets the width.

#### Scenario: Collapse and restore
- **WHEN** a user activates hide in the list chrome
- **THEN** the list is hidden, the editor spans the remaining width, and a show-list rail offers to restore it

#### Scenario: State is exposed
- **WHEN** a list visibility control receives keyboard focus
- **THEN** it shows a focus ring and its accessible name and expanded state describe the list's current visibility

#### Scenario: Narrow viewport opens straight into the editor
- **WHEN** a user opens or creates a workflow on a narrow viewport
- **THEN** the list collapses so the editor is what fills the screen

#### Scenario: Not offered where it does not apply
- **WHEN** the config tab, the runs tab, or a share or import view is showing
- **THEN** neither the hide control nor the show-list rail is offered

### Requirement: Default workflows view exposes import and share
The workflows list chrome MUST present New and Import as equal peer controls in one row. Import MUST open the same import route UI as `#import`, without requiring a picker deep link. When a saved workflow (non-empty name) is open in the editor, the workbench MUST provide a Share control in the command-bar overflow menu that opens the same share route UI as `#share=<scope>:<name>` for that workflow's current scope. These controls MUST be keyboard reachable with the same baseline affordances as other workbench buttons.

#### Scenario: Import from the list
- **WHEN** a user activates Import in the workflows list
- **THEN** the import review UI opens at `#import`

#### Scenario: Share from the editor
- **WHEN** a user has saved workflow `deploy` open from the repo scope and activates Share from the overflow menu
- **THEN** the share UI opens for `repo:deploy`

#### Scenario: New unsaved workflow has no share
- **WHEN** the blank new-workflow editor is open with an empty name
- **THEN** Share is not offered until the workflow has a saved name

