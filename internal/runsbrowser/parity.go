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
		{Spec: presentation, Requirement: "Runs use the fixed list chrome", Scenario: "More than six runs", Kind: "view", GoSurface: "ListViewport/Model.renderList", CoveringTest: "TestParityMoreThanSixRunsScrollsViewport"},
		{Spec: presentation, Requirement: "Runs use the fixed list chrome", Scenario: "Narrow popup", Kind: "view", GoSurface: "FormatRunRow", CoveringTest: "TestFormatRunRowNarrowTruncation"},
		{Spec: presentation, Requirement: "Runs use the fixed list chrome", Scenario: "Interrupted run", Kind: "view", GoSurface: "abbreviateStatus/FormatRunRow", CoveringTest: "TestParityInterruptedRunShowsTextStatus"},
		{Spec: presentation, Requirement: "Run filtering and scope are keyboard safe", Scenario: "Toggle all worktrees", Kind: "transition", GoSurface: "handleListKey ctrl+g/ScopeAll", CoveringTest: "TestCtrlGTogglesScopeFooter"},
		{Spec: presentation, Requirement: "Run filtering and scope are keyboard safe", Scenario: "Printable scope letter", Kind: "transition", GoSurface: "handleListKey printable g", CoveringTest: "TestPrintableGEntersFilter"},
		{Spec: presentation, Requirement: "Run filtering and scope are keyboard safe", Scenario: "Search a short displayed ID", Kind: "state", GoSurface: "Load/history.ListRuns DisplayID", CoveringTest: "TestParitySearchShortDisplayedID"},
		{Spec: presentation, Requirement: "Every selected run has a compact detail view", Scenario: "Inspect a successful run", Kind: "transition", GoSurface: "screenDetail/openDetail", CoveringTest: "TestEnterShowsDetailEscapeRestoresSelection"},
		{Spec: presentation, Requirement: "Every selected run has a compact detail view", Scenario: "Inspect an active run", Kind: "view", GoSurface: "DetailLines", CoveringTest: "TestParityInspectActiveAndToleratedDetailKinds"},
		{Spec: presentation, Requirement: "Every selected run has a compact detail view", Scenario: "Inspect a tolerated failure", Kind: "view", GoSurface: "DetailLines failed_continued", CoveringTest: "TestParityInspectActiveAndToleratedDetailKinds"},
		{Spec: presentation, Requirement: "Every selected run has a compact detail view", Scenario: "Return from detail", Kind: "transition", GoSurface: "handleDetailKey Escape", CoveringTest: "TestEnterShowsDetailEscapeRestoresSelection"},
		{Spec: presentation, Requirement: "Every selected run has a compact detail view", Scenario: "Workbench handoff fails", Kind: "action", GoSurface: "handleDetailKey w", CoveringTest: "TestParityWorkbenchHandoffNilKeepsDetail"},
		{Spec: presentation, Requirement: "Run-history empty states identify the remedy", Scenario: "No current runs", Kind: "view", GoSurface: "FormatRunListEmpty", CoveringTest: "TestEmptyCurrentShowsCtrlGHint"},
		{Spec: presentation, Requirement: "Run-history empty states identify the remedy", Scenario: "No machine runs", Kind: "view", GoSurface: "FormatRunListEmpty", CoveringTest: "TestParityNoMachineRunsCopy"},
		{Spec: presentation, Requirement: "Run-history empty states identify the remedy", Scenario: "Filter miss", Kind: "view", GoSurface: "FormatRunListEmpty FilterActive", CoveringTest: "TestFilterMissKeepsFilterRow"},
	}
}
