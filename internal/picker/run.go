package picker

import (
	"fmt"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/update"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

// ScreenOpts configures the picker TUI entrypoint.
type ScreenOpts struct {
	Entries            []workflow.WorkflowListEntry
	RepoRoot           string
	Config             config.Config
	CheckLatestRelease func() (*update.LatestRelease, error)
	LoadWorkflow       func(workflow.WorkflowListEntry) (*workflow.LoadedWorkflow, error)
	Chdir              func(string) error
	CopyClipboard      func(string) error
}

// RunScreen mounts the picker with Prepare, FilterInput, and a background update check.
func RunScreen(opts ScreenOpts) (int, error) {
	check := opts.CheckLatestRelease
	if check == nil {
		check = DefaultPickerReleaseCheck()
	}
	load := opts.LoadWorkflow
	copyFn := opts.CopyClipboard
	if copyFn == nil {
		copyFn = CopyToClipboard
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

	model, err := Prepare(Options{
		Entries:       opts.Entries,
		RepoRoot:      opts.RepoRoot,
		Config:        opts.Config,
		LoadWorkflow:  load,
		CopyClipboard: copyFn,
		Chdir:         opts.Chdir,
	})
	if err != nil {
		return 1, err
	}

	program = tea.NewProgram(model, tea.WithFilter(FilterInput))
	if pendingNewer {
		program.Send(NewerReleaseMsg{})
	}
	final, err := program.Run()
	if err != nil {
		return 1, fmt.Errorf("picker: %w", err)
	}
	if m, ok := final.(Model); ok && m.quit {
		return 0, nil
	}
	return 0, nil
}
