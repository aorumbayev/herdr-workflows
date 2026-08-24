# console-presentation — delta

## MODIFIED Requirements

### Requirement: Diagram send-back types an annotation bundle into an agent pane
On the diagram view, `v` MUST enter step selection mode where the user toggles step nodes by id. `s` MUST open an instruction prompt, assemble an annotation bundle from the selected step ids, their YAML fragments, and the typed instruction, and type that bundle into a target agent pane input without submitting it. The bundle MAY carry an optional failure block naming the run, checkout, step, cause, exit code, and step source. The failure block MUST NOT include the captured output tail. When more than one agent pane exists, the console MUST show a chooser before typing. Bundles larger than the agent prompt cap MUST spill to a private file and type the spill instruction instead. The host call MUST use `pane.send_text`.

#### Scenario: Select steps and send-back to one agent
- **WHEN** the user selects step `brief` on the handoff diagram, enters instruction text, and only one agent pane is available
- **THEN** that pane receives the bundle text typed but unsubmitted

#### Scenario: Choose among multiple agent panes
- **WHEN** the user confirms send-back and two agent panes are available
- **THEN** the console shows a chooser and types into the pane the user selects

#### Scenario: Oversize bundle spills to file
- **WHEN** the assembled annotation bundle exceeds the agent prompt byte cap
- **THEN** the typed text is the spill instruction naming an absolute path, not the raw bundle body
