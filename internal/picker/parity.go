package picker

// ParitySurface names one TypeScript-era picker scenario and its Go coverage.
type ParitySurface struct {
	Spec         string
	Requirement  string
	Scenario     string
	Kind         string
	GoSurface    string
	CoveringTest string
	Gap          string
}

// ParityBaseline is the picker comparison matrix for Cycle 5 slice 1.
func ParityBaseline() []ParitySurface {
	const presentation = "picker-presentation"
	const actions = "picker-workbench-actions"
	return []ParitySurface{
		{Spec: presentation, Requirement: "The picker names itself once", Scenario: "Title appears only in the pane label", Kind: "view", GoSurface: "Model.renderList", CoveringTest: "TestPickerDoesNotRenderPluginNameOrRetitle"},
		{Spec: presentation, Requirement: "The picker names itself once", Scenario: "No runtime retitling", Kind: "action", GoSurface: "New/Options.ReportPaneMetadata", CoveringTest: "TestPickerDoesNotRenderPluginNameOrRetitle"},
		{Spec: presentation, Requirement: "Fixed visible list viewport", Scenario: "More workflows than the viewport", Kind: "view", GoSurface: "ListViewport/Model.renderList", CoveringTest: "TestPickerViewportShowsSixRowsAndScrolls"},
		{Spec: presentation, Requirement: "Fixed visible list viewport", Scenario: "Cursor moves beyond the viewport", Kind: "transition", GoSurface: "Model.clampCursor", CoveringTest: "TestPickerViewportShowsSixRowsAndScrolls"},
		{Spec: presentation, Requirement: "Fixed visible list viewport", Scenario: "Fewer matches than the viewport", Kind: "view", GoSurface: "Model.renderList blank pad", CoveringTest: "TestParityFewerMatchesPadBlankRows"},
		{Spec: presentation, Requirement: "Rows are fixed-width columns, not a joined badge chain", Scenario: "Sensitive workflow", Kind: "view", GoSurface: "FormatPickerRowName/EntrySensitivity", CoveringTest: "TestBuildPickerOptionsTitleProvenanceAndSensitivity"},
		{Spec: presentation, Requirement: "Rows are fixed-width columns, not a joined badge chain", Scenario: "Unbounded flag list does not widen the row", Kind: "view", GoSurface: "FormatPickerRowName", CoveringTest: "TestFormatPickerRowWarningAndLocationColumns"},
		{Spec: presentation, Requirement: "Rows are fixed-width columns, not a joined badge chain", Scenario: "Overlong title", Kind: "view", GoSurface: "FormatPickerRowName", CoveringTest: "TestFormatPickerRowWarningAndLocationColumns"},
		{Spec: presentation, Requirement: "Rows are fixed-width columns, not a joined badge chain", Scenario: "Inputs are not advertised in the row", Kind: "view", GoSurface: "FormatPickerRowName", CoveringTest: "TestInputsAreNotAdvertisedInTheRow"},
		{Spec: presentation, Requirement: "Sensitivity flag names appear at the point of consent", Scenario: "Flags shown before run", Kind: "view", GoSurface: "FormatConsentLine/modeRun", CoveringTest: "TestAcceptCurrentPresentsSensitivityNames"},
		{Spec: presentation, Requirement: "Sensitivity flag names appear at the point of consent", Scenario: "Warnings are not the least legible element", Kind: "view", GoSurface: "Model.consentLine/tui.DefaultTheme.Warn", CoveringTest: "TestParityConsentUsesWarnWithoutDim"},
		{Spec: presentation, Requirement: "Invalid workflows appear in the list", Scenario: "Repository with a broken workflow file", Kind: "state", GoSurface: "BuildInvalidOptions", CoveringTest: "TestBuildInvalidOptionsStripsFilePrefix"},
		{Spec: presentation, Requirement: "Invalid workflows appear in the list", Scenario: "Selecting an invalid workflow", Kind: "view", GoSurface: "Model.renderList detail", CoveringTest: "TestParityInvalidRowDetailShowsLoadError"},
		{Spec: presentation, Requirement: "The selected workflow's detail is separated from the footer", Scenario: "Long description wraps instead of cropping", Kind: "view", GoSurface: "tui.FormatDetailLines", CoveringTest: "tui.TestFormatDetailLines"},
		{Spec: presentation, Requirement: "The selected workflow's detail is separated from the footer", Scenario: "Description too long for two lines", Kind: "view", GoSurface: "tui.FormatDetailLines", CoveringTest: "tui.TestFormatDetailLines"},
		{Spec: presentation, Requirement: "The selected workflow's detail is separated from the footer", Scenario: "Cursor moves", Kind: "transition", GoSurface: "Model.moveCursor/renderList", CoveringTest: "TestParityCursorMovesChangesDetailOnly"},
		{Spec: presentation, Requirement: "The selected workflow's detail is separated from the footer", Scenario: "Rule does not touch the border", Kind: "view", GoSurface: "tui.FormatRule", CoveringTest: "TestFormatRuleSpansRowTextField"},
		{Spec: presentation, Requirement: "Footer fits the popup and reports position", Scenario: "Hint is not clipped", Kind: "view", GoSurface: "tui.FormatListFooter", CoveringTest: "tui.TestFormatListFooter"},
		{Spec: presentation, Requirement: "Footer fits the popup and reports position", Scenario: "Position counter reflects the filtered list", Kind: "view", GoSurface: "tui.FormatListFooter", CoveringTest: "TestParityPositionCounterUsesFilteredList"},
		{Spec: presentation, Requirement: "Footer fits the popup and reports position", Scenario: "No scroll thumb", Kind: "view", GoSurface: "Model.renderList", CoveringTest: "TestParityNoScrollThumbGlyph"},
		{Spec: presentation, Requirement: "Footer fits the popup and reports position", Scenario: "Regular list footer", Kind: "view", GoSurface: "tui.ListHint", CoveringTest: "TestParityListFooterIdentifiesRunCtrlKDismiss"},
		{Spec: presentation, Requirement: "Filter matches the text the user can see", Scenario: "Filtering by displayed title", Kind: "state", GoSurface: "FilterWorkflowEntries", CoveringTest: "TestFilterWorkflowEntriesMatchesDisplayedTitleCaseInsensitively"},
		{Spec: presentation, Requirement: "Filter matches the text the user can see", Scenario: "Filtering by name", Kind: "state", GoSurface: "FilterWorkflowEntries", CoveringTest: "TestFilterWorkflowEntriesMatchesNameWhenTitleDiffers"},
		{Spec: presentation, Requirement: "Filter matches the text the user can see", Scenario: "Case is ignored", Kind: "state", GoSurface: "FilterWorkflowEntries", CoveringTest: "TestFilterWorkflowEntriesMatchesDisplayedTitleCaseInsensitively"},
		{Spec: presentation, Requirement: "Truncation derives from the rendered width", Scenario: "Narrow host pane", Kind: "view", GoSurface: "Model.contentWidth/FormatPickerRowName", CoveringTest: "TestWideTitlesStayAligned"},
		{Spec: presentation, Requirement: "Truncation derives from the rendered width", Scenario: "Width changes mid-session", Kind: "transition", GoSurface: "Model.Update WindowSizeMsg", CoveringTest: "TestParityWidthChangeRecomputesTruncation"},
		{Spec: presentation, Requirement: "Picker chrome uses width-stable ASCII glyphs", Scenario: "CJK locale", Kind: "view", GoSurface: "FormatPickerRowName/tui.Columns", CoveringTest: "TestWideTitlesStayAligned"},
		{Spec: presentation, Requirement: "Picker chrome uses width-stable ASCII glyphs", Scenario: "Font without box or arrow glyphs", Kind: "view", GoSurface: "tui.ChromeStrings", CoveringTest: "TestChromeStringsAreSingleColumnASCII"},
		{Spec: presentation, Requirement: "Input navigation preserves valid answers", Scenario: "Correct the final answer", Kind: "transition", GoSurface: "Model.inputBack", CoveringTest: "TestInputBackRestoresCollectedValue"},
		{Spec: presentation, Requirement: "Input navigation preserves valid answers", Scenario: "Mode change alters active inputs", Kind: "transition", GoSurface: "InputSession.Back/Answer", CoveringTest: "TestParityModeChangeDiscardsLaterAnswers"},
		{Spec: presentation, Requirement: "Input navigation preserves valid answers", Scenario: "Failed run navigation", Kind: "transition", GoSurface: "modeFail/modeRun Escape", CoveringTest: "TestParityFailedRunEscapeReturnsToListNotRuns", Gap: "Escape returns to modeList, not Runs root"},
		{Spec: presentation, Requirement: "Input prompts state what they collect", Scenario: "Dropdown of many options", Kind: "view", GoSurface: "FormatInputPrompt", CoveringTest: "TestParityFormatInputPromptOmitsOrdinal", Gap: "FormatInputPrompt omits collection ordinal (1 of N)"},
		{Spec: presentation, Requirement: "Input prompts state what they collect", Scenario: "Undescribed input", Kind: "view", GoSurface: "FormatInputPrompt", CoveringTest: "TestFormatInputPrompt"},
		{Spec: presentation, Requirement: "Input prompts state what they collect", Scenario: "Custom value accepted", Kind: "view", GoSurface: "FormatInputPrompt AllowCustom", CoveringTest: "TestFormatInputPrompt"},
		{Spec: presentation, Requirement: "Input prompts state what they collect", Scenario: "Constrained text input", Kind: "view", GoSurface: "FormatInputPrompt Default/MinLength", CoveringTest: "TestFormatInputPrompt"},
		{Spec: presentation, Requirement: "Input prompts state what they collect", Scenario: "Unresolved dynamic domain", Kind: "view", GoSurface: "FormatInputPrompt DynamicOptions", CoveringTest: "TestFormatInputPrompt"},
		{Spec: presentation, Requirement: "Collected answers stay visible during collection", Scenario: "A guarded domain is explained by an earlier answer", Kind: "view", GoSurface: "FormatInputAnswers/renderChoice", CoveringTest: "TestParityCollectedAnswersVisibleDuringInput"},
		{Spec: presentation, Requirement: "Collected answers stay visible during collection", Scenario: "First prompt has no answers", Kind: "view", GoSurface: "FormatInputAnswers", CoveringTest: "TestParityCollectedAnswersVisibleDuringInput"},
		{Spec: presentation, Requirement: "Collected answers stay visible during collection", Scenario: "Answers exceed the popup width", Kind: "view", GoSurface: "FormatInputAnswers", CoveringTest: "TestFormatInputAnswers"},
		{Spec: presentation, Requirement: "Collected answers stay visible during collection", Scenario: "Backward navigation drops later answers", Kind: "transition", GoSurface: "InputSession.Back", CoveringTest: "TestParityCollectedAnswersVisibleDuringInput"},
		{Spec: presentation, Requirement: "Empty catalog shows a friendly empty state without a filter", Scenario: "Hotkey with no workflows", Kind: "view", GoSurface: "Model.renderList empty", CoveringTest: "TestParityEmptyCatalogFooterAndMessage"},
		{Spec: presentation, Requirement: "Empty catalog shows a friendly empty state without a filter", Scenario: "Empty footer", Kind: "view", GoSurface: "tui.EmptyListHint", CoveringTest: "TestParityEmptyCatalogFooterAndMessage"},
		{Spec: presentation, Requirement: "Filter miss is distinct from an empty catalog", Scenario: "No matches for filter", Kind: "view", GoSurface: "Model.renderList filter miss", CoveringTest: "TestListFilterMissKeepsFilterRow"},
		{Spec: presentation, Requirement: "Tab switches the two root browsers", Scenario: "Workflow filter has text", Kind: "transition", GoSurface: "handleList tab", CoveringTest: "TestParityTabFromFilterDoesNotInsertTab"},
		{Spec: presentation, Requirement: "Tab switches the two root browsers", Scenario: "Input collection", Kind: "transition", GoSurface: "handleInput tab ignored", CoveringTest: "TestTabDoesNotSwitchDuringInputCollection"},
		{Spec: presentation, Requirement: "Tab switches the two root browsers", Scenario: "Return to workflows", Kind: "transition", GoSurface: "SwitchToWorkflowsMsg/modeList", CoveringTest: "TestTabSwitchesBetweenWorkflowAndRunsBrowsers"},
		{Spec: presentation, Requirement: "A launched workflow opens matching run detail", Scenario: "Child acknowledges start", Kind: "state", GoSurface: "modeRun", CoveringTest: "TestParityLaunchModeRunWithoutClaimLifecycle", Gap: "modeRun shows consent/name only; no UUID claim STARTING→RUNNING"},
		{Spec: presentation, Requirement: "A launched workflow opens matching run detail", Scenario: "Child cannot record history", Kind: "state", GoSurface: "modeRun", CoveringTest: "TestParityLaunchModeRunWithoutClaimLifecycle", Gap: "history-unavailable launch detail not wired in picker"},
		{Spec: presentation, Requirement: "A launched workflow opens matching run detail", Scenario: "Child fails before claim", Kind: "state", GoSurface: "modeRun", CoveringTest: "TestParityLaunchModeRunWithoutClaimLifecycle", Gap: "local launch-failure detail not wired in picker"},
		{Spec: presentation, Requirement: "A launched workflow opens matching run detail", Scenario: "Fast successful workflow", Kind: "state", GoSurface: "modeRun", CoveringTest: "TestParityLaunchModeRunWithoutClaimLifecycle", Gap: "live success detail not attached after acceptCurrent"},
		{Spec: presentation, Requirement: "A launched workflow opens matching run detail", Scenario: "Leave an active launch", Kind: "transition", GoSurface: "modeRun Escape", CoveringTest: "TestParityLaunchModeRunWithoutClaimLifecycle", Gap: "Escape returns to modeList; no detach of child observation"},

		{Spec: actions, Requirement: "Workbench actions reuse a repository endpoint", Scenario: "Existing workbench", Kind: "action", GoSurface: "workbench.OpenWorkbench", CoveringTest: "workbench.TestLiveMatchingEndpointReused"},
		{Spec: actions, Requirement: "Workbench actions reuse a repository endpoint", Scenario: "Stale endpoint", Kind: "action", GoSurface: "workbench.OpenWorkbench", CoveringTest: "workbench.TestStaleOrMismatchedRecordsNotReused"},
		{Spec: actions, Requirement: "Workbench actions reuse a repository endpoint", Scenario: "Different repository", Kind: "action", GoSurface: "workbench.OpenWorkbench", CoveringTest: "workbench.TestStaleOrMismatchedRecordsNotReused"},
		{Spec: actions, Requirement: "Endpoint credentials remain private runtime state", Scenario: "Endpoint record written", Kind: "state", GoSurface: "workbench.WriteEndpointRecord", CoveringTest: "workbench.TestEndpointRecordPrivateAndProbe"},
		{Spec: actions, Requirement: "Endpoint credentials remain private runtime state", Scenario: "Environment-controlled state directory is checked", Kind: "action", GoSurface: "credentials.AssertCredentialStoreSafe", CoveringTest: "credentials.TestAssertCredentialStoreSafeAcceptsUserOnlyDir"},
		{Spec: actions, Requirement: "Endpoint credentials remain private runtime state", Scenario: "Lock file carries the same protection", Kind: "state", GoSurface: "workbench endpoint lock", CoveringTest: "workbench.TestEndpointRecordPrivateAndProbe"},
		{Spec: actions, Requirement: "Picker reports published plugin updates without blocking", Scenario: "Newer release appears after mount", Kind: "view", GoSurface: "NewerReleaseMsg/FormatFilterUpdateHint", CoveringTest: "TestUpdateIndicator"},
		{Spec: actions, Requirement: "Picker reports published plugin updates without blocking", Scenario: "Update service is unavailable", Kind: "action", GoSurface: "StartUpdateCheck", CoveringTest: "TestStartUpdateCheckNeverBlocksAndIgnoresFailures"},
		{Spec: actions, Requirement: "Picker reports published plugin updates without blocking", Scenario: "Draft is not advertised", Kind: "action", GoSurface: "UpdateAvailable/StartUpdateCheck", CoveringTest: "TestStartUpdateCheckNeverBlocksAndIgnoresFailures"},
		{Spec: actions, Requirement: "List mode opens an actions palette with Ctrl+K", Scenario: "Open palette", Kind: "transition", GoSurface: "handleList ctrl+k/modePalette", CoveringTest: "TestPickerFilterAndPaletteRestore"},
		{Spec: actions, Requirement: "List mode opens an actions palette with Ctrl+K", Scenario: "Printable k filters", Kind: "transition", GoSurface: "handleList printable", CoveringTest: "TestParityPrintableKFilters"},
		{Spec: actions, Requirement: "List mode opens an actions palette with Ctrl+K", Scenario: "Escape closes palette", Kind: "transition", GoSurface: "handlePalette Escape", CoveringTest: "TestPickerFilterAndPaletteRestore"},
		{Spec: actions, Requirement: "Palette actions for authorship and discovery", Scenario: "New from empty catalog", Kind: "action", GoSurface: "ResolvePaletteLetter n", CoveringTest: "TestParityPaletteLettersResolveWithoutHandoff", Gap: "handlePalette returns to list; no workbench #new handoff or dismiss"},
		{Spec: actions, Requirement: "Palette actions for authorship and discovery", Scenario: "Import from empty catalog", Kind: "action", GoSurface: "ResolvePaletteLetter i", CoveringTest: "TestPaletteLetters", Gap: "handlePalette returns to list; no workbench #import handoff"},
		{Spec: actions, Requirement: "Palette actions for authorship and discovery", Scenario: "Browse examples", Kind: "action", GoSurface: "ResolvePaletteLetter e", CoveringTest: "TestParityPaletteLettersResolveWithoutHandoff", Gap: "no platform browser opener from handlePalette"},
		{Spec: actions, Requirement: "Palette open edits the selected workflow", Scenario: "Open repo workflow", Kind: "action", GoSurface: "ResolvePaletteLetter o", CoveringTest: "TestPaletteLetters", Gap: "route resolved only; handlePalette does not open workbench"},
		{Spec: actions, Requirement: "Palette open edits the selected workflow", Scenario: "Open without selection", Kind: "action", GoSurface: "ResolvePaletteLetter o", CoveringTest: "TestPaletteLetters"},
		{Spec: actions, Requirement: "Palette share copies the import command and notifies", Scenario: "Share copies command", Kind: "action", GoSurface: "ResolvePaletteLetter s", CoveringTest: "TestParityPaletteLettersResolveWithoutHandoff", Gap: "share letter resolves Entry but does not clipboard/notify"},
		{Spec: actions, Requirement: "Palette share copies the import command and notifies", Scenario: "Share does not open workbench", Kind: "action", GoSurface: "ResolvePaletteLetter s", CoveringTest: "TestParityPaletteLettersResolveWithoutHandoff"},
		{Spec: actions, Requirement: "Palette delete confirms then removes the workflow file", Scenario: "Confirmed delete", Kind: "transition", GoSurface: "modeDelete/BeginConfirmedDelete", CoveringTest: "TestConfirmedDeleteRemovesFile"},
		{Spec: actions, Requirement: "Palette delete confirms then removes the workflow file", Scenario: "Cancel delete", Kind: "transition", GoSurface: "handleDelete n/esc", CoveringTest: "TestParityCancelDeleteKeepsFile"},
	}
}
