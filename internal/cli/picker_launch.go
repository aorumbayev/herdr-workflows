package cli

import (
	"errors"
	"fmt"
	"os"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/console"
	"github.com/aorumbayev/herdr-workflows/internal/engine"
	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/picker"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

func runLaunch(_ *cobra.Command, _ []string) error {
	if err := host.EnsureHerdrProtocol(); err != nil {
		return err
	}
	app, err := config.LoadContext(config.LoadOptions{FromInvocation: true})
	if err != nil {
		return err
	}
	env := map[string]string{"HERDR_WORKFLOWS_REPO_ROOT": app.RepoRoot}
	if v := os.Getenv("HERDR_PLUGIN_CONTEXT_JSON"); v != "" {
		env["HERDR_PLUGIN_CONTEXT_JSON"] = v
	}
	if err := host.PluginPaneOpen("picker", env, "popup"); err != nil {
		var herdr *host.HerdrError
		if errors.As(err, &herdr) && herdr.Code == "ui_busy" {
			_ = host.NotificationShow("herdr-workflows", "Another popup is open — close it first.")
			return nil
		}
		return err
	}
	return nil
}

func runPicker(cmd *cobra.Command, _ []string) error {
	if err := host.EnsureHerdrProtocol(); err != nil {
		return err
	}
	if reopen, _ := cmd.Flags().GetBool("reopen"); reopen {
		return runPopupReopen()
	}
	if !cmdHasTTY(cmd) {
		return fmt.Errorf("picker requires a tty")
	}
	app, err := config.LoadContext(config.LoadOptions{FromInvocation: true})
	if err != nil {
		return err
	}
	entries, err := workflow.ListWorkflows(app.RepoRoot, app.Config)
	if err != nil {
		return err
	}
	opts := buildPickerOptions(app, entries)
	opts.Restore = picker.ParsePopupState(os.Getenv(picker.PopupStateEnv))
	opts.ReopenPopup = spawnPopupReopen
	code, err := picker.RunScreen(opts)
	if err != nil {
		return err
	}
	if code != 0 {
		return &exitCodeError{code: code, msg: fmt.Sprintf("picker exited %d", code)}
	}
	return nil
}

func buildPickerOptions(app config.AppContext, entries []workflow.ListEntry) picker.Options {
	execPath, _ := os.Executable()
	repoRoot := app.RepoRoot
	cfg := app.Config
	ctx := app.Ctx
	return picker.Options{
		Entries:  entries,
		RepoRoot: repoRoot,
		Config:   cfg,
		Env:      os.Getenv,
		LoadWorkflow: func(entry workflow.ListEntry) (*workflow.Definition, error) {
			return workflow.LoadWorkflowEntry(entry, repoRoot, cfg)
		},
		OpenURL: func(url string) error {
			config.OpenInBrowser(url)
			return nil
		},
		Notify:        host.NotificationShow,
		AllocateRunID: history.AllocateRunID,
		ExportShare: func(entry workflow.ListEntry) (string, error) {
			exported, err := workflow.ExportWorkflowBundle(entry.Name, entry.Source, repoRoot)
			if err != nil {
				return "", err
			}
			return exported.Command, nil
		},
		LaunchRun: func(opts picker.LaunchRunOpts) picker.LaunchRunHandle {
			events := make(chan picker.LaunchEvent, 16)
			handle := engine.LaunchDetachedRun(engine.LaunchRunRequest{
				Name:       opts.Name,
				RepoRoot:   opts.RepoRoot,
				Executable: execPath,
				Ctx:        ctx,
				Inputs:     opts.Inputs,
				Domains:    opts.Domains,
				RunID:      opts.RunID,
				OnHistoryAck: func(line string) {
					events <- picker.LaunchEvent{Ack: line}
				},
			})
			go func() {
				if r := <-handle.Result; !r.OK {
					events <- picker.LaunchEvent{Fail: r.Detail}
				}
				close(events)
			}()
			return picker.LaunchRunHandle{Detach: handle.Detach, Events: events}
		},
		OpenConsole: func(placement console.Placement, workflowName string) error {
			env := map[string]string{"HERDR_WORKFLOWS_REPO_ROOT": repoRoot}
			if v := os.Getenv("HERDR_PLUGIN_CONTEXT_JSON"); v != "" {
				env["HERDR_PLUGIN_CONTEXT_JSON"] = v
			}
			if workflowName != "" {
				env[consoleWorkflowEnv] = workflowName
			}
			return host.PluginPaneOpenPlaced("console", string(placement), env)
		},
		OpenEditor: func(path, name, placement string) error {
			env := map[string]string{
				"HERDR_WORKFLOWS_REPO_ROOT": repoRoot,
				picker.EditorFileEnv:        path,
				picker.EditorNameEnv:        name,
			}
			if v := os.Getenv("HERDR_PLUGIN_CONTEXT_JSON"); v != "" {
				env["HERDR_PLUGIN_CONTEXT_JSON"] = v
			}
			return host.PluginPaneOpenPlaced("editor", placement, env)
		},
		ListAgentPanes: func() ([]console.AgentPaneEntry, error) {
			panes, err := host.ListAgentPanes()
			if err != nil {
				return nil, err
			}
			return console.AgentPaneEntriesFromHost(panes), nil
		},
		PaneSendText: host.PaneSendText,
	}
}

func cmdHasTTY(cmd *cobra.Command) bool {
	in, okIn := cmd.InOrStdin().(*os.File)
	out, okOut := cmd.OutOrStdout().(*os.File)
	if !okIn || !okOut {
		return false
	}
	return term.IsTerminal(int(in.Fd())) && term.IsTerminal(int(out.Fd()))
}
