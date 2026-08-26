package cli

import (
	"errors"
	"fmt"
	"os"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/console"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
	"github.com/spf13/cobra"
)

// consoleWorkflowEnv carries the picker's selected workflow into the popped-out
// console pane, so it lands on that workflow's diagram.
const consoleWorkflowEnv = "HWF_CONSOLE_WORKFLOW"

var (
	consoleHasTTY = cmdHasTTY
	consoleScreen = runConsoleScreen
)

func runConsole(cmd *cobra.Command, _ []string) error {
	raw, err := cmd.Flags().GetString("placement")
	if err != nil {
		return err
	}
	placement, err := console.ParsePlacement(raw)
	if err != nil {
		return err
	}
	if cmd.Flags().Changed("placement") {
		err := openConsolePane(placement)
		if err == nil || !paneHostUnavailable(err) || !consoleHasTTY(cmd) {
			return err
		}
	}
	if !consoleHasTTY(cmd) {
		return fmt.Errorf("console requires a tty")
	}
	return consoleScreen(cmd)
}

func runConsoleScreen(_ *cobra.Command) error {
	if err := host.EnsureHerdrProtocol(); err != nil {
		return err
	}
	app, err := config.LoadContext(config.LoadOptions{FromInvocation: true})
	if err != nil {
		return err
	}
	entries, err := workflow.ListWorkflows(app.RepoRoot, app.Config)
	if err != nil {
		return err
	}
	code, err := console.RunScreen(console.Options{
		Entries:         entries,
		RepoRoot:        app.RepoRoot,
		Config:          app.Config,
		Env:             os.Getenv,
		LandingWorkflow: os.Getenv(consoleWorkflowEnv),
	})
	if err != nil {
		return err
	}
	if code != 0 {
		return &exitCodeError{code: code, msg: fmt.Sprintf("console exited %d", code)}
	}
	return nil
}

func openConsolePane(placement console.Placement) error {
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
	if err := host.PluginPaneOpenPlaced("console", string(placement), env); err != nil {
		var herdr *host.HerdrError
		if errors.As(err, &herdr) && herdr.Code == "ui_busy" {
			_ = host.NotificationShow("herdr-workflows", "Another popup is open — close it first.")
			return nil
		}
		return err
	}
	return nil
}

func paneHostUnavailable(err error) bool {
	return host.IsTransportLoss(err)
}
