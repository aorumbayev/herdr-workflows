## Context

The workbench is a single served HTML bundle. `renderEditor()` owns the workflow name, scope, YAML buffer, mode switch, and explicit save action; `makeCanvas()` owns visual node state and a bounded undo-only stack. Canvas changes are already formatted into the shared YAML buffer after a 300 ms debounce. `dumpWorkflow()` serializes formatted visual-editor documents and currently mis-indents nested fields in `on_failure`.

The implementation must remain dependency-free, preserve explicit save and leave-page protection, use semantic Nord tokens in both themes, and keep all controls keyboard and assistive-technology accessible.

## Goals / Non-Goals

**Goals:**

- Make the saved and unsaved states unambiguous without autosave.
- Replace the redundant move action with save-mediated scope changes.
- Provide mode-aware Undo and Redo controls.
- Improve canvas structural hierarchy and offer an expanded viewport mode.
- Preserve valid workflow YAML through visual-editor round trips, including recovery actions.

**Non-Goals:**

- Autosave, collaboration, persisted history, or history across mode conversion.
- A new editor framework, state-management layer, CSS theme, or dependency.
- True browser fullscreen or changes to workflow grammar and API routes.

## Decisions

### Compare against a saved baseline

`renderEditor()` will retain the last saved name, scope, and YAML text. A single dirty-state update compares current values with that baseline and controls leave protection, the unsaved marker, and Save visibility. Canvas mutations mark the editor dirty immediately; completion of the existing format debounce updates the YAML comparison so undoing back to the baseline can restore the clean state.

Save remains the only persistence action. A changed scope or name is written first, and the original path is deleted only after that write succeeds. The separate move button is removed.

Alternative considered: keep the current event-only boolean. Rejected because undoing to the saved content would still claim there are changes to save.

### Route one history control pair by editor mode

YAML mode will reuse the textarea's native history, which the editor already preserves through `execCommand`-based edits. Canvas mode will extend its existing bounded snapshot history with a redo stack. Undo pushes the current state to redo; redo pushes the current state to undo; every new mutation clears redo. Existing-node form editing records one pre-edit snapshot, while adding and configuring a new node remains one undoable addition.

Alternative considered: replace both modes with a unified snapshot manager. Rejected because it duplicates native text behavior and requires cursor and selection restoration.

### Expand inside the browser viewport

An explicit canvas control will toggle a fixed viewport overlay rather than invoke the browser Fullscreen API. Expansion retains all canvas controls, locks document scrolling, exits through the control or Escape, and restores focus to the trigger. The fit action receives an unambiguous accessible name so it cannot be confused with expansion.

Alternative considered: true browser fullscreen. Rejected because browser permission and chrome behavior vary and add no workflow-editing capability.

### Increase structural contrast through theme tokens

Both theme blocks will define semantic node-surface, node-border, node-shadow, edge, and port values. Nodes receive a clearer elevated surface and restrained shadow; edges and ports become stronger. Existing action icon colors remain the only type color coding. Component rules continue to contain no color literals.

Alternative considered: colored action-type rails. Rejected because they add visual noise and redundant encoding.

### Fix recovery serialization at the shared formatter

When converting the list-shaped output of `dumpStep()` into the mapping-shaped `on_failure` block, the formatter will remove one indentation level from every emitted line, as well as the first line's list marker. A round-trip test will cover a recovery Herdr action with nested `params`.

Alternative considered: special-case `params`. Rejected because any second or later recovery field has the same root indentation defect.

## Risks / Trade-offs

- Native text history does not expose a portable exact history depth for button disabling. The YAML controls can remain enabled and safely no-op when no operation is available; canvas controls use exact stack state.
- Canvas formatting is asynchronous. Mutation marks dirty synchronously, and only the latest format sequence can update the baseline comparison, preserving the existing last-write-wins guard.
- A fixed overlay can strand focus if teardown occurs while expanded. Editor teardown and mode changes will always exit expanded mode and restore document overflow.
- Stronger contrast can regress either theme. Semantic token and browser checks cover dark and light rendering without adding theme-conditional component rules.
