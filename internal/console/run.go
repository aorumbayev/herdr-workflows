package console

import (
	"fmt"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

// ScreenOpts configures the console TUI entrypoint.
type ScreenOpts struct {
	Entries  []workflow.WorkflowListEntry
	RepoRoot string
	Config   config.Config
	Env      config.Env
}

// RunScreen mounts the console TUI.
func RunScreen(opts ScreenOpts) (int, error) {
	model := New(Options{
		Entries:  opts.Entries,
		RepoRoot: opts.RepoRoot,
		Env:      opts.Env,
	})
	program := tea.NewProgram(model)
	final, err := program.Run()
	if err != nil {
		return 1, fmt.Errorf("console: %w", err)
	}
	if m, ok := final.(Model); ok && m.quit {
		return 0, nil
	}
	return 0, nil
}
