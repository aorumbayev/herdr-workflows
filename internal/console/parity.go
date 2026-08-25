package console

// ParitySurface names one console scenario and the Go coverage for it.
type ParitySurface struct {
	Spec         string
	Requirement  string
	Scenario     string
	Kind         string
	GoSurface    string
	CoveringTest string
}

// ParityBaseline is the console comparison matrix for console-presentation.
func ParityBaseline() []ParitySurface {
	const presentation = "console-presentation"
	return []ParitySurface{
		{Spec: presentation, Requirement: "Console opens at tab, beside, or below", Scenario: "Default beside from the overlay", Kind: "transition", GoSurface: "picker.beginConsolePlacement", CoveringTest: "picker.TestPaletteConsoleOpensPlacementChooser"},
		{Spec: presentation, Requirement: "Chrome uses one-cell horizontal padding", Scenario: "Console content inset", Kind: "view", GoSurface: "tui.PadContent", CoveringTest: "tui.TestPadContentAddsHorizontalPadding"},
		{Spec: presentation, Requirement: "Detail block reserves two rows under the list", Scenario: "Workflows and runs list detail", Kind: "view", GoSurface: "tui.FormatDetailBlock", CoveringTest: "tui.TestFormatDetailBlockReservesTwoRows"},
		{Spec: presentation, Requirement: "Console opens at tab, beside, or below", Scenario: "Invalid CLI placement", Kind: "action", GoSurface: "cli.runConsole/ParsePlacement", CoveringTest: "cli.TestConsoleRejectsInvalidPlacement"},
		{Spec: presentation, Requirement: "Run detail exposes log, transcript, and yaml-at-run", Scenario: "Switch debug tabs", Kind: "view", GoSurface: "Model.handleDetailKey/FormatDebugBody", CoveringTest: "TestModelRunDetailDebugTabsAndRetryCopy"},
		{Spec: presentation, Requirement: "Run detail exposes log, transcript, and yaml-at-run", Scenario: "Retry-copy", Kind: "action", GoSurface: "FormatRetryCommand", CoveringTest: "TestModelRunDetailDebugTabsAndRetryCopy"},
		{Spec: presentation, Requirement: "Workflow diagram projects the parsed definition", Scenario: "Open diagram from the workflows list", Kind: "view", GoSurface: "Model.openSelectedDiagram/tui.RenderRail", CoveringTest: "TestModelWorkflowDiagramScreen"},
		{Spec: presentation, Requirement: "Workflow diagram projects the parsed definition", Scenario: "Return from diagram", Kind: "transition", GoSurface: "Model.handleDiagramKey", CoveringTest: "TestModelWorkflowDiagramScreen"},
		{Spec: presentation, Requirement: "Diagram send-back types an annotation bundle into an agent pane", Scenario: "Select steps and send-back to one agent", Kind: "action", GoSurface: "Model.finishSendback/PaneSendText", CoveringTest: "TestModelDiagramSendbackSingleAgent"},
		{Spec: presentation, Requirement: "Diagram send-back types an annotation bundle into an agent pane", Scenario: "Choose among multiple agent panes", Kind: "action", GoSurface: "Model.handleDiagramAgentPickKey", CoveringTest: "TestModelDiagramSendbackAgentChooser"},
		{Spec: presentation, Requirement: "Diagram send-back types an annotation bundle into an agent pane", Scenario: "Oversize bundle spills to file", Kind: "action", GoSurface: "MaybeSpillSendbackText", CoveringTest: "TestMaybeSpillSendbackTextOverCap"},
		{Spec: presentation, Requirement: "Console is reached by pop-out only", Scenario: "Pop-out from the picker uses placement", Kind: "transition", GoSurface: "picker.beginConsolePlacement/handleConsolePlace", CoveringTest: "picker.TestPaletteConsoleOpensPlacementChooser"},
		{Spec: presentation, Requirement: "Workflow diagram projects the parsed definition", Scenario: "Derived run and agent titles", Kind: "view", GoSurface: "workflow.ProjectDiagram/railTitle", CoveringTest: "workflow.TestProjectDiagramDerivedRunAndAgentLabels"},
		{Spec: presentation, Requirement: "Diagram send-back types an annotation bundle into an agent pane", Scenario: "Empty selection sends the whole workflow", Kind: "action", GoSurface: "Model.finishSendback/formatAnnotationBundle", CoveringTest: "TestModelDiagramSendbackWholeWorkflow"},
		{Spec: presentation, Requirement: "Console watches the workflow file and keeps last-good diagram", Scenario: "Valid save refreshes the rail", Kind: "state", GoSurface: "Model.handleWatchTick", CoveringTest: "TestModelDiagramWatchReloadsValidFile"},
		{Spec: presentation, Requirement: "Console watches the workflow file and keeps last-good diagram", Scenario: "Invalid save keeps last-good", Kind: "state", GoSurface: "Model.handleWatchTick", CoveringTest: "TestModelDiagramWatchKeepsLastGoodOnInvalid"},
		{Spec: presentation, Requirement: "Console watches the workflow file and keeps last-good diagram", Scenario: "Selection follows declared ids", Kind: "state", GoSurface: "reresolveFocus/reselectIDs", CoveringTest: "TestReresolveFocusDropsMissingID"},
		{Spec: presentation, Requirement: "Diagram mouse navigates and never writes YAML", Scenario: "Pointer focuses a card", Kind: "transition", GoSurface: "Model.handleDiagramClick", CoveringTest: "TestModelDiagramClickFocusesCard"},
		{Spec: presentation, Requirement: "Diagram mouse navigates and never writes YAML", Scenario: "Multi-select uses declared ids", Kind: "transition", GoSurface: "Model.handleDiagramClick", CoveringTest: "TestModelDiagramCtrlClickTogglesSelection"},
		{Spec: presentation, Requirement: "Diagram mouse navigates and never writes YAML", Scenario: "Card without an id shows an unavailable mark", Kind: "view", GoSurface: "tui.RenderCard/Model.toggleFocusedCard", CoveringTest: "TestModelDiagramToggleOnIDLessCardExplains"},
		{Spec: presentation, Requirement: "Diagram mouse navigates and never writes YAML", Scenario: "`a` asks before or after the focused card", Kind: "action", GoSurface: "Model.seedInsertInstruction/handleDiagramInsertSideKey", CoveringTest: "TestModelDiagramASksInsertSide"},
		{Spec: presentation, Requirement: "Diagram mouse navigates and never writes YAML", Scenario: "Insert side prompt cancels", Kind: "transition", GoSurface: "Model.handleDiagramInsertSideKey", CoveringTest: "TestModelDiagramInsertSideEscapes"},
		{Spec: presentation, Requirement: "Diagram mouse navigates and never writes YAML", Scenario: "Arrows step card to card", Kind: "transition", GoSurface: "moveRailFocus", CoveringTest: "TestModelDiagramArrowsStepCardToCard"},
		{Spec: presentation, Requirement: "Workflow diagram projects the parsed definition", Scenario: "YAML pane scrolls past the viewport", Kind: "view", GoSurface: "Model.scrollDiagramYAML/railYAMLLines", CoveringTest: "TestModelDiagramYAMLPaneScrolls"},
		{Spec: presentation, Requirement: "Workflow diagram projects the parsed definition", Scenario: "Arrows keep the rail still while the focus shows", Kind: "view", GoSurface: "railScrollIntoView", CoveringTest: "TestModelDiagramArrowsKeepScrollUntilFocusLeavesWindow"},
		{Spec: presentation, Requirement: "Console watches the workflow file and keeps last-good diagram", Scenario: "Stale poll tick dies", Kind: "state", GoSurface: "Model.handleWatchTick/watchTick", CoveringTest: "TestModelDiagramWatchTickIgnoresStaleEpoch"},
		{Spec: presentation, Requirement: "Diagram send-back types an annotation bundle into an agent pane", Scenario: "Composer names the target and the anchor", Kind: "view", GoSurface: "Model.renderDiagramInstruction/composerScope/anchorLabel", CoveringTest: "TestDiagramComposerNamesAnchorAndWrapsDraft"},
		{Spec: presentation, Requirement: "Diagram send-back types an annotation bundle into an agent pane", Scenario: "Card anchor names the focused step", Kind: "action", GoSurface: "Model.annotationBundle", CoveringTest: "TestModelDiagramCardAnchorNamesTheStep"},
		{Spec: presentation, Requirement: "Console mouse reporting is on in both hosts", Scenario: "Standalone console reports mouse", Kind: "view", GoSurface: "Model.View MouseMode", CoveringTest: "TestModelConsoleViewEnablesMouseReporting"},
	}
}
