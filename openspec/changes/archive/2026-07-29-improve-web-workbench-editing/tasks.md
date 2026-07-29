## 1. Recovery Round Trip

- [x] 1.1 Correct recovery-action indentation in the shared workflow formatter
- [x] 1.2 Add a server regression that formats and reparses recovery actions with nested parameters

## 2. Explicit Save State

- [x] 2.1 Compare workflow name, scope, and YAML against the saved baseline and update leave protection from that result
- [x] 2.2 Show the textual unsaved indicator and Save only while dirty
- [x] 2.3 Remove the move action and apply scope changes only through write-first explicit Save

## 3. Mode-Aware History

- [x] 3.1 Add bounded canvas redo state and cover node movement, addition, removal, ordering, and form changes
- [x] 3.2 Route accessible Undo and Redo controls to native YAML history or canvas history by active mode

## 4. Canvas Presentation

- [x] 4.1 Add dark and light semantic tokens for structurally distinct node surfaces, borders, shadows, ports, and edges
- [x] 4.2 Add an accessible viewport-filling canvas mode with toggle and Escape exit, scroll restoration, and focus restoration

## 5. Verification

- [x] 5.1 Add focused presentation and interaction regressions for dirty state, history controls, contrast tokens, and expanded view
- [x] 5.2 Run the focused web tests and repository verification gate
