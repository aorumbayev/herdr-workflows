package runsbrowser

import (
	"github.com/aorumbayev/herdr-workflows/internal/history"
)

// Scope is Current or All checkout filtering.
type Scope string

const (
	ScopeCurrent Scope = "current"
	ScopeAll     Scope = "all"
)

// State is the list payload that Load makes.
type State struct {
	Scope          Scope
	Filter         string
	Items          []history.Summary
	SelectedID     string
	HasMachineRuns bool
	Unavailable    bool
}

// DetailView is one shown detail screen.
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
