package picker

import (
	"fmt"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

// RunScreen starts the picker with Prepare, FilterInput, and a background update check.
func RunScreen(opts Options) (int, error) {
	check := opts.CheckLatestRelease
	if check == nil {
		check = DefaultPickerReleaseCheck()
	}
	if opts.CopyClipboard == nil {
		opts.CopyClipboard = tui.CopyToClipboard
	}

	var program *tea.Program
	pendingNewer := false
	onNewer := func(string) {
		if program != nil {
			program.Send(NewerReleaseMsg{})
			return
		}
		pendingNewer = true
	}
	StartUpdateCheck(UpdateCheck{
		Check:           check,
		EmbeddedVersion: config.ProductVersion,
		OnNewer:         onNewer,
	})

	model, err := Prepare(opts)
	if err != nil {
		return 1, err
	}

	program = tea.NewProgram(model, tea.WithFilter(FilterInput))
	if pendingNewer {
		program.Send(NewerReleaseMsg{})
	}
	_, err = program.Run()
	if err != nil {
		return 1, fmt.Errorf("picker: %w", err)
	}
	return 0, nil
}
