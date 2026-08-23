package console

// ParitySurface names one console scenario and its Go coverage.
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
		{Spec: presentation, Requirement: "Console opens at tab, beside, or below", Scenario: "Default beside from the overlay", Kind: "transition", GoSurface: "picker.beginConsolePlacement", CoveringTest: "TestPaletteConsoleOpensPlacementChooser"},
		{Spec: presentation, Requirement: "Chrome uses one-cell horizontal padding", Scenario: "Console content inset", Kind: "view", GoSurface: "tui.PadContent", CoveringTest: "tui.TestPadContentAddsHorizontalPadding"},
		{Spec: presentation, Requirement: "Detail block reserves two rows under the list", Scenario: "Workflows and runs list detail", Kind: "view", GoSurface: "tui.FormatDetailBlock", CoveringTest: "tui.TestFormatDetailBlockReservesTwoRows"},
		{Spec: presentation, Requirement: "Console opens at tab, beside, or below", Scenario: "Invalid CLI placement", Kind: "action", GoSurface: "cli.runConsole/ParsePlacement", CoveringTest: "TestConsoleRejectsInvalidPlacement"},
		{Spec: presentation, Requirement: "Run detail exposes log, transcript, and yaml-at-run", Scenario: "Switch debug tabs", Kind: "view", GoSurface: "Model.handleDetailKey/FormatDebugBody", CoveringTest: "TestModelRunDetailDebugTabsAndRetryCopy"},
		{Spec: presentation, Requirement: "Run detail exposes log, transcript, and yaml-at-run", Scenario: "Retry-copy", Kind: "action", GoSurface: "FormatRetryCommand", CoveringTest: "TestModelRunDetailDebugTabsAndRetryCopy"},
		{Spec: presentation, Requirement: "Workflow diagram projects the parsed definition", Scenario: "Open diagram from the workflows list", Kind: "view", GoSurface: "Model.openSelectedDiagram/FormatDiagram", CoveringTest: "TestModelWorkflowDiagramScreen"},
		{Spec: presentation, Requirement: "Workflow diagram projects the parsed definition", Scenario: "Return from diagram", Kind: "transition", GoSurface: "Model.handleDiagramKey", CoveringTest: "TestModelWorkflowDiagramScreen"},
		{Spec: presentation, Requirement: "Diagram send-back types an annotation bundle into an agent pane", Scenario: "Select steps and send-back to one agent", Kind: "action", GoSurface: "Model.finishSendback/PaneSendText", CoveringTest: "TestModelDiagramSendbackSingleAgent"},
		{Spec: presentation, Requirement: "Diagram send-back types an annotation bundle into an agent pane", Scenario: "Choose among multiple agent panes", Kind: "action", GoSurface: "Model.handleDiagramAgentPickKey", CoveringTest: "TestModelDiagramSendbackAgentChooser"},
		{Spec: presentation, Requirement: "Diagram send-back types an annotation bundle into an agent pane", Scenario: "Oversize bundle spills to file", Kind: "action", GoSurface: "MaybeSpillSendbackText", CoveringTest: "TestMaybeSpillSendbackTextOverCap"},
	}
}
