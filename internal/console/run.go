package console

import (
	"fmt"

	tea "charm.land/bubbletea/v2"
)

// ScreenOpts is a temporary alias so internal/cli keeps compiling until it
// constructs Options directly. Remove after cli migrates.
type ScreenOpts = Options

// RunScreen mounts the console TUI.
func RunScreen(opts Options) (int, error) {
	model := New(opts)
	program := tea.NewProgram(model)
	_, err := program.Run()
	if err != nil {
		return 1, fmt.Errorf("console: %w", err)
	}
	return 0, nil
}
