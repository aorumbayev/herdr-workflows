## ADDED Requirements

### Requirement: Canvas structure is visually distinct in both themes
The canvas MUST use semantic theme tokens to distinguish its background, workflow nodes, node borders, ports, and connecting edges in dark and light themes. Nodes MUST appear elevated from the canvas and connecting edges MUST remain readily visible without adding redundant action-type color rails. Component rules MUST continue to contain no color literals.

#### Scenario: Dark canvas hierarchy
- **WHEN** the dark theme canvas displays a workflow
- **THEN** node surfaces and borders are distinct from the canvas and edges remain visible between nodes

#### Scenario: Light canvas hierarchy
- **WHEN** the light theme canvas displays a workflow
- **THEN** the same structural hierarchy remains visible using light-theme semantic token overrides

### Requirement: Editing state and canvas view controls are accessible
Undo, Redo, Save, and canvas expansion controls MUST have accessible names, visible focus states, hover and active states, and a hit target of at least 32px in the smaller dimension. The unsaved-state indicator MUST be exposed as text rather than color alone.

#### Scenario: Keyboard navigation
- **WHEN** a keyboard user traverses workflow editor actions
- **THEN** each available history, save, and expansion control receives a visible focus ring and exposes its action by accessible name

#### Scenario: Unsaved state without color perception
- **WHEN** a workflow differs from its saved baseline
- **THEN** the interface displays text identifying unsaved changes in addition to any color cue
