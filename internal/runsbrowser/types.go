package runsbrowser

import "github.com/aorumbayev/herdr-workflows/internal/history"

// ListViewport is the six-row Select height shared with the picker.
const ListViewport = 6

// Scope is Current vs All checkout filtering.
type Scope string

const (
	ScopeCurrent Scope = "current"
	ScopeAll     Scope = "all"
)

// State is the list payload load produces.
type State struct {
	Scope          Scope
	Filter         string
	Items          []history.ListItem
	SelectedID     string
	HasMachineRuns bool
	Unavailable    bool
}

// DetailView is one painted detail screen.
type DetailView struct {
	Kind     string
	ID       string
	Workflow string
	Message  string
	Progress []string
	Finished string
	Detail   history.Detail
	Blocks   []history.Block
}
