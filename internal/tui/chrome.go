package tui

const (
	// ChromeSep joins chrome fragments.
	ChromeSep = " | "

	ListHint            = "tab runs" + ChromeSep + "enter run" + ChromeSep + "ctrl+k" + ChromeSep + "esc"
	EmptyListHint       = "tab runs | ctrl+k | esc"
	PaletteHint         = "letter fires | esc back"
	DeleteConfirmHint   = "y delete | n cancel | esc"
	ChoiceHint          = "type filter" + ChromeSep + "up/down move" + ChromeSep + "enter select" + ChromeSep + "esc back"
	CustomChoiceHint    = "type filter" + ChromeSep + "up/down" + ChromeSep + "enter select/custom" + ChromeSep + "esc back"
	RunHint             = "esc dismiss" + ChromeSep + "run continues"
	FailHint            = "enter/esc close"
	CustomChoiceLabel   = "custom..."
	FilterWorkflows     = "filter workflows..."
	FilterRuns          = "filter runs..."
	PromptPlaceholder   = "prompt..."
	SubmitHint          = "enter submit" + ChromeSep + "esc back"
	EmptyCatalogMessage = "Hi there, looks like you got no runnable workflows, start by creating a new one, browsing examples or importing an existing workflow."
	CursorPrefix        = "> "
	WarningMark         = "! "
)

// ChromeStrings is every chrome fragment the picker draws. Each glyph must be
// unambiguous single-column ASCII.
var ChromeStrings = []string{
	ListHint,
	EmptyListHint,
	PaletteHint,
	DeleteConfirmHint,
	ChoiceHint,
	CustomChoiceHint,
	RunHint,
	FailHint,
	CustomChoiceLabel,
	Ellipsis,
	ChromeSep,
	CursorPrefix,
	WarningMark,
	FilterWorkflows,
	FilterRuns,
	PromptPlaceholder,
	SubmitHint,
	EmptyCatalogMessage,
}
