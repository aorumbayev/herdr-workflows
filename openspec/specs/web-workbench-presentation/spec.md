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
