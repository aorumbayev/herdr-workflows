package runsbrowser

// ParitySurface names one TypeScript-era runs-browser scenario and its Go coverage.
type ParitySurface struct {
	Spec         string
	Requirement  string
	Scenario     string
	Kind         string
	GoSurface    string
	CoveringTest string
}

// ParityBaseline is the runs-browser comparison matrix for Cycle 5 slice 1.
func ParityBaseline() []ParitySurface {
	const presentation = "picker-presentation"
	return []ParitySurface{
		{Spec: presentation, Requirement: "Runs use the fixed list chrome", Scenario: "More than six runs", Kind: "view", GoSurface: "Model.listViewport/Model.renderList", CoveringTest: "TestParityMoreThanSixRunsScrollsViewport"},
		{Spec: presentation, Requirement: "List viewport fills the popup above a six-row floor", Scenario: "Tall host shows more runs", Kind: "view", GoSurface: "tui.FitViewport/Model.listViewport", CoveringTest: "TestRunsViewportGrowsWithHostHeight"},
		{Spec: presentation, Requirement: "List viewport fills the popup above a six-row floor", Scenario: "Run detail fills the host", Kind: "view", GoSurface: "Model.detailRows/Model.renderDetail", CoveringTest: "TestRunsViewportGrowsWithHostHeight"},
		{Spec: presentation, Requirement: "Runs use the fixed list chrome", Scenario: "Narrow popup", Kind: "view", GoSurface: "FormatRunRow/tui.PadContent", CoveringTest: "TestFormatRunRowNarrowTruncation"},
		{Spec: presentation, Requirement: "Runs use the fixed list chrome", Scenario: "Interrupted run", Kind: "view", GoSurface: "abbreviateStatus/FormatRunRow", CoveringTest: "TestParityInterruptedRunShowsTextStatus"},
		{Spec: presentation, Requirement: "Run filtering and scope are keyboard safe", Scenario: "Toggle all worktrees", Kind: "transition", GoSurface: "handleListKey ctrl+g/ScopeAll", CoveringTest: "TestCtrlGTogglesScopeFooter"},
		{Spec: presentation, Requirement: "Run filtering and scope are keyboard safe", Scenario: "Printable scope letter", Kind: "transition", GoSurface: "handleListKey printable g", CoveringTest: "TestPrintableGEntersFilter"},
		{Spec: presentation, Requirement: "Run filtering and scope are keyboard safe", Scenario: "Search a short displayed ID", Kind: "state", GoSurface: "Load/history.ListRuns DisplayID", CoveringTest: "TestParitySearchShortDisplayedID"},
		{Spec: presentation, Requirement: "Every selected run has a compact detail view", Scenario: "Inspect a successful run", Kind: "transition", GoSurface: "screenDetail/openDetail", CoveringTest: "TestEnterShowsDetailEscapeRestoresSelection"},
		{Spec: presentation, Requirement: "Every selected run has a compact detail view", Scenario: "Inspect an active run", Kind: "view", GoSurface: "DetailLines/tui.FormatDetailBlock", CoveringTest: "tui.TestFormatDetailBlockReservesTwoRows"},
		{Spec: presentation, Requirement: "Every selected run has a compact detail view", Scenario: "Inspect a failed run", Kind: "view", GoSurface: "renderRailDetail/detailPaneLines", CoveringTest: "TestFailedRunDetailShowsCauseAndSource"},
		{Spec: presentation, Requirement: "Every selected run has a compact detail view", Scenario: "Inspect a tolerated failure", Kind: "view", GoSurface: "DetailLines failed_continued", CoveringTest: "TestParityInspectActiveAndToleratedDetailKinds"},
		{Spec: presentation, Requirement: "Failed run detail offers send-back to an agent", Scenario: "Send back the failed step", Kind: "action", GoSurface: "picker.beginRunsSendback/FormatAnnotationBundle", CoveringTest: "TestRunsSendbackOmitsOutputTail"},
		{Spec: presentation, Requirement: "Failed run detail offers send-back to an agent", Scenario: "Choose an agent pane", Kind: "transition", GoSurface: "picker.handleRunsAgentPick", CoveringTest: "TestRunsSendbackAgentChooser"},
		{Spec: presentation, Requirement: "Every selected run has a compact detail view", Scenario: "Return from detail", Kind: "transition", GoSurface: "handleDetailKey Escape", CoveringTest: "TestEnterShowsDetailEscapeRestoresSelection"},
		{Spec: presentation, Requirement: "Run-history empty states identify the remedy", Scenario: "No current runs", Kind: "view", GoSurface: "FormatRunListEmpty", CoveringTest: "TestEmptyCurrentShowsCtrlGHint"},
		{Spec: presentation, Requirement: "Run-history empty states identify the remedy", Scenario: "No machine runs", Kind: "view", GoSurface: "FormatRunListEmpty", CoveringTest: "TestParityNoMachineRunsCopy"},
		{Spec: presentation, Requirement: "Run-history empty states identify the remedy", Scenario: "Filter miss", Kind: "view", GoSurface: "FormatRunListEmpty FilterActive", CoveringTest: "TestFilterMissKeepsFilterRow"},
	}
}
