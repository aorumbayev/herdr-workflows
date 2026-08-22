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
		{Spec: presentation, Requirement: "Console opens at tab, beside, or below", Scenario: "Invalid CLI placement", Kind: "action", GoSurface: "cli.runConsole/ParsePlacement", CoveringTest: "TestConsoleRejectsInvalidPlacement"},
		{Spec: presentation, Requirement: "Run detail exposes log, transcript, and yaml-at-run", Scenario: "Switch debug tabs", Kind: "view", GoSurface: "Model.handleDetailKey/FormatDebugBody", CoveringTest: "TestModelRunDetailDebugTabsAndRetryCopy"},
		{Spec: presentation, Requirement: "Run detail exposes log, transcript, and yaml-at-run", Scenario: "Retry-copy", Kind: "action", GoSurface: "FormatRetryCommand", CoveringTest: "TestModelRunDetailDebugTabsAndRetryCopy"},
	}
}
