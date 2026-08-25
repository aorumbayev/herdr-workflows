package tui

const (
	// ChromeSep joins chrome fragments.
	ChromeSep = " | "

	ListHint            = "tab" + ChromeSep + "enter run" + ChromeSep + "ctrl+k" + ChromeSep + "esc"
	EmptyListHint       = "tab" + ChromeSep + "ctrl+k" + ChromeSep + "esc"
	ConsoleHint         = "tab" + ChromeSep + "enter diagram" + ChromeSep + "p pop out" + ChromeSep + "esc"
	PaletteHint         = "letter fires | esc back"
	DeleteConfirmHint   = "y delete | n cancel | esc"
	ChoiceHint          = "type filter" + ChromeSep + "up/down move" + ChromeSep + "enter select" + ChromeSep + "esc back"
	CustomChoiceHint    = "type filter" + ChromeSep + "up/down" + ChromeSep + "enter select/custom" + ChromeSep + "esc back"
	FailHint            = "enter/esc close"
	CustomChoiceLabel   = "custom..."
	FilterWorkflows     = "filter workflows..."
	FilterRuns          = "filter runs..."
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
	ConsoleHint,
	TabWorkflows,
	TabRuns,
	PaletteHint,
	DeleteConfirmHint,
	ChoiceHint,
	CustomChoiceHint,
	FailHint,
	CustomChoiceLabel,
	Ellipsis,
	ChromeSep,
	CursorPrefix,
	FilterWorkflows,
	FilterRuns,
	PromptPlaceholder,
	SubmitHint,
	CreateNameHint,
	EmptyCatalogMessage,
}
