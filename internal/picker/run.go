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
	Env                config.Env
	CheckLatestRelease func() (*update.LatestRelease, error)
	LoadWorkflow       func(workflow.WorkflowListEntry) (*workflow.Definition, error)
	Chdir              func(string) error
	CopyClipboard      func(string) error
	EditWorkflow       func(path, name string) workflow.ValidateResult
	OpenURL            func(url string) error
	Notify             func(title string, body ...string) error
	LaunchRun          func(LaunchRunOpts) LaunchRunHandle
	AllocateRunID      func() string
	ExportShare        func(entry workflow.WorkflowListEntry) (command string, err error)
}

// PrepareScreen changes the working directory and builds a picker model from ScreenOpts hooks.
func PrepareScreen(opts ScreenOpts) (Model, error) {
	copyFn := opts.CopyClipboard
	if copyFn == nil {
		copyFn = CopyToClipboard
	}
	return Prepare(Options{
		Entries:       opts.Entries,
		RepoRoot:      opts.RepoRoot,
		Config:        opts.Config,
		Env:           opts.Env,
		LoadWorkflow:  opts.LoadWorkflow,
		CopyClipboard: copyFn,
		Chdir:         opts.Chdir,
		EditWorkflow:  opts.EditWorkflow,
		OpenURL:       opts.OpenURL,
		Notify:        opts.Notify,
		LaunchRun:     opts.LaunchRun,
		AllocateRunID: opts.AllocateRunID,
		ExportShare:   opts.ExportShare,
	})
}

// RunScreen mounts the picker with PrepareScreen, FilterInput, and a background update check.
func RunScreen(opts ScreenOpts) (int, error) {
	check := opts.CheckLatestRelease
	if check == nil {
		check = DefaultPickerReleaseCheck()
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

	model, err := PrepareScreen(opts)
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
