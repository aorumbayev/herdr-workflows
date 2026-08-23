package picker

// ParitySurface names one TypeScript-era picker scenario and its Go coverage.
type ParitySurface struct {
	Spec         string
	Requirement  string
	Scenario     string
	Kind         string
	GoSurface    string
	CoveringTest string
}

// ParityBaseline is the picker comparison matrix for editor/import actions.
func ParityBaseline() []ParitySurface {
	const presentation = "picker-presentation"
	const actions = "picker-editor-actions"
	return []ParitySurface{
		{Spec: presentation, Requirement: "The picker names itself once", Scenario: "Title appears only in the pane label", Kind: "view", GoSurface: "Model.renderList", CoveringTest: "TestPickerDoesNotRenderPluginNameOrRetitle"},
		{Spec: presentation, Requirement: "The picker names itself once", Scenario: "No runtime retitling", Kind: "action", GoSurface: "New/View", CoveringTest: "TestPickerDoesNotRenderPluginNameOrRetitle"},
		{Spec: presentation, Requirement: "Fixed visible list viewport", Scenario: "More workflows than the viewport", Kind: "view", GoSurface: "ListViewport/Model.renderList", CoveringTest: "TestPickerViewportShowsSixRowsAndScrolls"},
		{Spec: presentation, Requirement: "Fixed visible list viewport", Scenario: "Cursor moves beyond the viewport", Kind: "transition", GoSurface: "Model.clampCursor", CoveringTest: "TestPickerViewportShowsSixRowsAndScrolls"},
		{Spec: presentation, Requirement: "Fixed visible list viewport", Scenario: "Fewer matches than the viewport", Kind: "view", GoSurface: "Model.renderList blank pad", CoveringTest: "TestParityFewerMatchesPadBlankRows"},
		{Spec: presentation, Requirement: "Rows are fixed-width columns, not a joined badge chain", Scenario: "Sensitive workflow", Kind: "view", GoSurface: "FormatPickerRowName/EntrySensitivity", CoveringTest: "TestBuildPickerOptionsTitleProvenanceAndSensitivity"},
		{Spec: presentation, Requirement: "Rows are fixed-width columns, not a joined badge chain", Scenario: "Unbounded flag list does not widen the row", Kind: "view", GoSurface: "FormatPickerRowName", CoveringTest: "TestFormatPickerRowWarningAndLocationColumns"},
		{Spec: presentation, Requirement: "Rows are fixed-width columns, not a joined badge chain", Scenario: "Overlong title", Kind: "view", GoSurface: "FormatPickerRowName", CoveringTest: "TestFormatPickerRowWarningAndLocationColumns"},
		{Spec: presentation, Requirement: "Rows are fixed-width columns, not a joined badge chain", Scenario: "Inputs are not advertised in the row", Kind: "view", GoSurface: "FormatPickerRowName", CoveringTest: "TestInputsAreNotAdvertisedInTheRow"},
		{Spec: presentation, Requirement: "Sensitivity flag names appear at the point of consent", Scenario: "Flags shown before run", Kind: "view", GoSurface: "FormatConsentLine/beginLaunch", CoveringTest: "TestAcceptCurrentPresentsSensitivityNames"},
		{Spec: presentation, Requirement: "Sensitivity flag names appear at the point of consent", Scenario: "Warnings are not the least legible element", Kind: "view", GoSurface: "Model.consentLine/tui.DefaultTheme.Warn", CoveringTest: "TestParityConsentUsesWarnWithoutDim"},
		{Spec: presentation, Requirement: "Invalid workflows appear in the list", Scenario: "Repository with a broken workflow file", Kind: "state", GoSurface: "BuildInvalidOptions", CoveringTest: "TestBuildInvalidOptionsStripsFilePrefix"},
		{Spec: presentation, Requirement: "Invalid workflows appear in the list", Scenario: "Selecting an invalid workflow", Kind: "view", GoSurface: "Model.renderList detail", CoveringTest: "TestParityInvalidRowDetailShowsLoadError"},
		{Spec: presentation, Requirement: "The selected workflow's detail is separated from the footer", Scenario: "Long description wraps instead of cropping", Kind: "view", GoSurface: "tui.FormatDetailLines", CoveringTest: "tui.TestFormatDetailLines"},
		{Spec: presentation, Requirement: "The selected workflow's detail is separated from the footer", Scenario: "Description too long for two lines", Kind: "view", GoSurface: "tui.FormatDetailBlock", CoveringTest: "tui.TestFormatDetailBlockReservesTwoRows"},
		{Spec: presentation, Requirement: "The selected workflow's detail is separated from the footer", Scenario: "Cursor moves", Kind: "transition", GoSurface: "Model.moveCursor/renderList", CoveringTest: "TestParityCursorMovesChangesDetailOnly"},
		{Spec: presentation, Requirement: "The selected workflow's detail is separated from the footer", Scenario: "Rule does not touch the border", Kind: "view", GoSurface: "tui.FormatRule/tui.PadContent", CoveringTest: "TestFormatRuleSpansRowTextField"},
		{Spec: presentation, Requirement: "Footer fits the popup and reports position", Scenario: "Hint is not clipped", Kind: "view", GoSurface: "tui.FormatListFooter", CoveringTest: "tui.TestFormatListFooter"},
		{Spec: presentation, Requirement: "Footer fits the popup and reports position", Scenario: "Position counter reflects the filtered list", Kind: "view", GoSurface: "tui.FormatListFooter", CoveringTest: "TestParityPositionCounterUsesFilteredList"},
		{Spec: presentation, Requirement: "Footer fits the popup and reports position", Scenario: "No scroll thumb", Kind: "view", GoSurface: "Model.renderList", CoveringTest: "TestParityNoScrollThumbGlyph"},
		{Spec: presentation, Requirement: "Footer fits the popup and reports position", Scenario: "Regular list footer", Kind: "view", GoSurface: "tui.ListHint", CoveringTest: "TestParityListFooterIdentifiesRunCtrlKDismiss"},
		{Spec: presentation, Requirement: "Filter matches the text the user can see", Scenario: "Filtering by displayed title", Kind: "state", GoSurface: "FilterWorkflowEntries", CoveringTest: "TestFilterWorkflowEntriesMatchesDisplayedTitleCaseInsensitively"},
		{Spec: presentation, Requirement: "Filter matches the text the user can see", Scenario: "Filtering by name", Kind: "state", GoSurface: "FilterWorkflowEntries", CoveringTest: "TestFilterWorkflowEntriesMatchesNameWhenTitleDiffers"},
		{Spec: presentation, Requirement: "Filter matches the text the user can see", Scenario: "Case is ignored", Kind: "state", GoSurface: "FilterWorkflowEntries", CoveringTest: "TestFilterWorkflowEntriesMatchesDisplayedTitleCaseInsensitively"},
		{Spec: presentation, Requirement: "Truncation derives from the rendered width", Scenario: "Narrow host pane", Kind: "view", GoSurface: "tui.PadContent/Model.contentWidth", CoveringTest: "tui.TestPadContentAddsHorizontalPadding"},
		{Spec: presentation, Requirement: "Truncation derives from the rendered width", Scenario: "Width changes mid-session", Kind: "transition", GoSurface: "Model.Update WindowSizeMsg", CoveringTest: "TestParityWidthChangeRecomputesTruncation"},
		{Spec: presentation, Requirement: "Picker chrome uses width-stable ASCII glyphs", Scenario: "CJK locale", Kind: "view", GoSurface: "FormatPickerRowName/tui.Columns", CoveringTest: "TestWideTitlesStayAligned"},
		{Spec: presentation, Requirement: "Picker chrome uses width-stable ASCII glyphs", Scenario: "Font without box or arrow glyphs", Kind: "view", GoSurface: "tui.ChromeStrings", CoveringTest: "TestChromeStringsAreSingleColumnASCII"},
		{Spec: presentation, Requirement: "Picker chrome uses width-stable ASCII glyphs", Scenario: "Charm flush-left filter without slash prefix", Kind: "view", GoSurface: "FormatListFilterRow", CoveringTest: "TestFilterRowIsFlushLeftASCIIWithoutSlashPrefix"},
		{Spec: presentation, Requirement: "Picker chrome uses width-stable ASCII glyphs", Scenario: "ASCII greater-than cursor on choice option rows", Kind: "view", GoSurface: "tui.FormatRow/renderChoice", CoveringTest: "TestParityChoiceRowsUseASCIICursor"},
		{Spec: presentation, Requirement: "Input navigation preserves valid answers", Scenario: "Correct the final answer", Kind: "transition", GoSurface: "Model.inputBack", CoveringTest: "TestInputBackRestoresCollectedValue"},
		{Spec: presentation, Requirement: "Input navigation preserves valid answers", Scenario: "Mode change alters active inputs", Kind: "transition", GoSurface: "InputSession.Back/Answer", CoveringTest: "TestParityModeChangeDiscardsLaterAnswers"},
		{Spec: presentation, Requirement: "Input navigation preserves valid answers", Scenario: "Failed run navigation", Kind: "transition", GoSurface: "modeRuns Escape", CoveringTest: "TestParityFailedRunEscapeReturnsToRunsRoot"},
		{Spec: presentation, Requirement: "Input prompts state what they collect", Scenario: "Dropdown of many options", Kind: "view", GoSurface: "FormatInputPrompt", CoveringTest: "TestParityFormatInputPromptReportsOrdinal"},
		{Spec: presentation, Requirement: "Input prompts state what they collect", Scenario: "Undescribed input", Kind: "view", GoSurface: "FormatInputPrompt", CoveringTest: "TestFormatInputPrompt"},
		{Spec: presentation, Requirement: "Input prompts state what they collect", Scenario: "Custom value accepted", Kind: "view", GoSurface: "FormatInputPrompt AllowCustom", CoveringTest: "TestFormatInputPrompt"},
		{Spec: presentation, Requirement: "Input prompts state what they collect", Scenario: "Constrained text input", Kind: "view", GoSurface: "FormatInputPrompt Default/MinLength", CoveringTest: "TestFormatInputPrompt"},
		{Spec: presentation, Requirement: "Input prompts state what they collect", Scenario: "Unresolved dynamic domain", Kind: "view", GoSurface: "FormatInputPrompt DynamicOptions", CoveringTest: "TestFormatInputPrompt"},
		{Spec: presentation, Requirement: "Input prompts state what they collect", Scenario: "Title row keeps named sensitivity flags", Kind: "view", GoSurface: "FormatConsentLine/renderChoice", CoveringTest: "TestParityInputTitleRowKeepsSensitivityFlags"},
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
		{Spec: presentation, Requirement: "A launched workflow opens matching run detail", Scenario: "Child acknowledges start", Kind: "state", GoSurface: "beginLaunch/launchAckMsg", CoveringTest: "TestParityLaunchOpensStartingRunningLifecycle"},
		{Spec: presentation, Requirement: "A launched workflow opens matching run detail", Scenario: "Child cannot record history", Kind: "state", GoSurface: "beginLaunch/launchAckMsg", CoveringTest: "TestParityLaunchOpensStartingRunningLifecycle"},
		{Spec: presentation, Requirement: "A launched workflow opens matching run detail", Scenario: "Child fails before claim", Kind: "state", GoSurface: "beginLaunch/launchSettledMsg", CoveringTest: "TestParityLaunchOpensStartingRunningLifecycle"},
		{Spec: presentation, Requirement: "A launched workflow opens matching run detail", Scenario: "Fast successful workflow", Kind: "state", GoSurface: "beginLaunch/launchSettledMsg", CoveringTest: "TestParityLaunchOpensStartingRunningLifecycle"},
		{Spec: presentation, Requirement: "A launched workflow opens matching run detail", Scenario: "Leave an active launch", Kind: "transition", GoSurface: "handleRunsKey Escape", CoveringTest: "TestParityLaunchOpensStartingRunningLifecycle"},

		{Spec: actions, Requirement: "Picker reports published plugin updates without blocking", Scenario: "Newer release appears after mount", Kind: "view", GoSurface: "NewerReleaseMsg/FormatFilterUpdateHint", CoveringTest: "TestUpdateIndicator"},
		{Spec: actions, Requirement: "Picker reports published plugin updates without blocking", Scenario: "Update service is unavailable", Kind: "action", GoSurface: "StartUpdateCheck", CoveringTest: "TestStartUpdateCheckNeverBlocksAndIgnoresFailures"},
		{Spec: actions, Requirement: "Picker reports published plugin updates without blocking", Scenario: "Draft is not advertised", Kind: "action", GoSurface: "UpdateAvailable/StartUpdateCheck", CoveringTest: "TestStartUpdateCheckNeverBlocksAndIgnoresFailures"},
		{Spec: actions, Requirement: "List mode opens an actions palette with Ctrl+K", Scenario: "Open palette", Kind: "transition", GoSurface: "handleList ctrl+k/modePalette", CoveringTest: "TestPickerFilterAndPaletteRestore"},
		{Spec: actions, Requirement: "List mode opens an actions palette with Ctrl+K", Scenario: "Printable k filters", Kind: "transition", GoSurface: "handleList printable", CoveringTest: "TestParityPrintableKFilters"},
		{Spec: actions, Requirement: "List mode opens an actions palette with Ctrl+K", Scenario: "Escape closes palette", Kind: "transition", GoSurface: "handlePalette Escape", CoveringTest: "TestPickerFilterAndPaletteRestore"},
		{Spec: actions, Requirement: "Palette actions for authorship and discovery", Scenario: "New from empty catalog", Kind: "action", GoSurface: "handlePalette n/beginEdit", CoveringTest: "TestParityPaletteLettersHandoff"},
		{Spec: actions, Requirement: "Palette actions for authorship and discovery", Scenario: "Import from empty catalog", Kind: "action", GoSurface: "handlePalette i", CoveringTest: "TestParityPaletteLettersHandoff"},
		{Spec: actions, Requirement: "Palette actions for authorship and discovery", Scenario: "Browse examples", Kind: "action", GoSurface: "handlePalette e", CoveringTest: "TestParityPaletteLettersHandoff"},
		{Spec: actions, Requirement: "Palette open edits the selected workflow", Scenario: "Open repo workflow", Kind: "action", GoSurface: "handlePalette o/beginEdit", CoveringTest: "TestParityPaletteLettersHandoff"},
		{Spec: actions, Requirement: "Palette open edits the selected workflow", Scenario: "Open without selection", Kind: "action", GoSurface: "ResolvePaletteLetter o", CoveringTest: "TestPaletteLetters"},
		{Spec: actions, Requirement: "Palette share copies the import command and notifies", Scenario: "Share copies command", Kind: "action", GoSurface: "handlePalette s", CoveringTest: "TestParityPaletteLettersHandoff"},
		{Spec: actions, Requirement: "Palette share copies the import command and notifies", Scenario: "Share stays in picker", Kind: "action", GoSurface: "handlePalette s", CoveringTest: "TestParityPaletteLettersHandoff"},
		{Spec: actions, Requirement: "Palette delete confirms then removes the workflow file", Scenario: "Confirmed delete", Kind: "transition", GoSurface: "modeDelete/BeginConfirmedDelete", CoveringTest: "TestConfirmedDeleteRemovesFile"},
		{Spec: actions, Requirement: "Palette delete confirms then removes the workflow file", Scenario: "Cancel delete", Kind: "transition", GoSurface: "handleDelete n/esc", CoveringTest: "TestParityCancelDeleteKeepsFile"},
	}
}
