package tui

const (
	// ChromeSep joins chrome fragments.
	ChromeSep = " | "

	ListHint            = "tab" + ChromeSep + "enter run" + ChromeSep + "ctrl+p actions" + ChromeSep + "esc"
	EmptyListHint       = "tab" + ChromeSep + "ctrl+p actions" + ChromeSep + "esc"
	PaletteHint         = "letter fires | esc back"
	DeleteConfirmHint   = "y delete | n cancel | esc"
	ChoiceHint          = "type filter" + ChromeSep + "up/down move" + ChromeSep + "enter select" + ChromeSep + "esc back"
	CustomChoiceHint    = "type filter" + ChromeSep + "up/down" + ChromeSep + "enter select/custom" + ChromeSep + "esc back"
	FailHint            = "enter/esc close"
	BackHint            = "esc back"
	TouchesPrefix       = "! touches: "
	CustomChoiceLabel   = "custom..."
	FilterWorkflows     = "filter workflows..."
	FilterRuns          = "filter runs..."
	FilterOptions       = "filter options..."
	PromptPlaceholder   = "prompt..."
	SubmitHint          = "enter submit" + ChromeSep + "esc back"
	CreateNameHint      = "enter create" + ChromeSep + "esc cancel"
	EmptyCatalogMessage = "Hi there, looks like you got no runnable workflows, start by creating a new one, browsing examples or importing an existing workflow."
	CursorPrefix        = "> "

	TabWorkflows = "workflows"
	TabRuns      = "runs"
)

// ChromeStrings is every chrome fragment that the picker shows. Each glyph must be
// unambiguous single-column ASCII.
var ChromeStrings = []string{
	ListHint,
	EmptyListHint,
	TabWorkflows,
	TabRuns,
	PaletteHint,
	DeleteConfirmHint,
	ChoiceHint,
	CustomChoiceHint,
	FailHint,
	BackHint,
	TouchesPrefix,
	CustomChoiceLabel,
	Ellipsis,
	ChromeSep,
	CursorPrefix,
	FilterWorkflows,
	FilterRuns,
	FilterOptions,
	PromptPlaceholder,
	SubmitHint,
	CreateNameHint,
	EmptyCatalogMessage,
}
