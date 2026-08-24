package console

import (
	"fmt"

	tea "charm.land/bubbletea/v2"
)

// RunScreen starts the console TUI.
func RunScreen(opts Options) (int, error) {
	model := New(opts)
	program := tea.NewProgram(model)
	_, err := program.Run()
	if err != nil {
		return 1, fmt.Errorf("console: %w", err)
	}
	return 0, nil
}
