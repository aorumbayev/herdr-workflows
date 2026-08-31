package tui

const (
	// ChromeSep joins chrome fragments.
	ChromeSep = " | "

	ListHint             = "enter run" + ChromeSep + "ctrl+p actions" + ChromeSep + "esc"
	EmptyListHint        = "ctrl+p actions" + ChromeSep + "esc"
	ProfilesListHint     = "enter open" + ChromeSep + "ctrl+p actions" + ChromeSep + "esc"
	ProfilesEmptyHint    = "ctrl+p actions" + ChromeSep + "esc"
	AgentStatusLegend    = "* busy  - idle  ! blocked"
	PaletteHint          = "letter fires | esc back"
	DeleteConfirmHint    = "y delete | n cancel | esc"
	ChoiceHint           = "type filter" + ChromeSep + "up/down move" + ChromeSep + "enter select" + ChromeSep + "esc back"
	CustomChoiceHint     = "type filter" + ChromeSep + "up/down" + ChromeSep + "enter select/custom" + ChromeSep + "esc back"
	FailHint             = "enter/esc close"
	BackHint             = "esc back"
	TouchesPrefix        = "! touches: "
	CustomChoiceLabel    = "custom..."
	FilterWorkflows      = "filter workflows..."
	FilterRuns           = "filter runs..."
	FilterProfiles       = "filter profiles..."
	ProfilesEmptyMessage = "No profiles yet. Press ctrl+p then n to add one."
	FilterOptions        = "filter options..."
	PromptPlaceholder    = "prompt..."
	SubmitHint           = "enter submit" + ChromeSep + "esc back"
	CreateNameHint       = "enter create" + ChromeSep + "esc cancel"
	EmptyCatalogMessage  = "Hi there, looks like you got no runnable workflows, start by creating a new one, browsing examples or importing an existing workflow."
	CursorPrefix         = "> "
	FieldCursor          = ">"

	TabWorkflows = "workflows"
	TabRuns      = "runs"
	TabProfiles  = "profiles"
)

// ChromeStrings is every chrome fragment that the picker shows. Each glyph must be
// unambiguous single-column ASCII.
var ChromeStrings = []string{
	ListHint,
	EmptyListHint,
	ProfilesListHint,
	ProfilesEmptyHint,
	AgentStatusLegend,
	ProfilesEmptyMessage,
	TabWorkflows,
	TabRuns,
	TabProfiles,
	FilterProfiles,
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
	FieldCursor,
	FilterWorkflows,
	FilterRuns,
	FilterOptions,
	PromptPlaceholder,
	SubmitHint,
	CreateNameHint,
	EmptyCatalogMessage,
}
