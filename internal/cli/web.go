package cli

import (
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/engine"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/picker"
	"github.com/aorumbayev/herdr-workflows/internal/workbench"
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
	code, err := picker.RunScreen(picker.ScreenOpts{
		Entries:  entries,
		RepoRoot: app.RepoRoot,
		Config:   app.Config,
		LoadWorkflow: func(entry workflow.WorkflowListEntry) (*workflow.Definition, error) {
			return workflow.LoadWorkflowEntry(entry, app.RepoRoot, app.Config)
		},
	})
	if err != nil {
		return err
	}
	if code != 0 {
		return &exitCodeError{code: code, msg: fmt.Sprintf("picker exited %d", code)}
	}
	return nil
}

func runWeb(cmd *cobra.Command, args []string) error {
	var routeRaw string
	if len(args) > 0 {
		routeRaw = args[0]
	}
	var route *workbench.WebRoute
	if routeRaw != "" {
		route = workbench.ParseWebRoute(routeRaw)
		if route == nil {
			return fmt.Errorf(
				"web route expects w=<repo|global>:<name>, share=<repo|global>:<name>, run=<uuid>, import, or new, got '%s'",
				routeRaw,
			)
		}
	}
	portFlag := cmd.Flags().Lookup("port")
	port, _ := cmd.Flags().GetInt("port")
	if portFlag != nil && portFlag.Changed {
		if _, err := parsePort(strconv.Itoa(port)); err != nil {
			return err
		}
	}
	noOpen, _ := cmd.Flags().GetBool("no-open")

	app, err := config.LoadContext(config.LoadOptions{})
	if err != nil {
		return err
	}
	execPath, err := os.Executable()
	if err != nil {
		return err
	}
	build, _ := engine.BuildIdentity("", execPath)
	handle, err := workbench.OpenWorkbench(workbench.OpenWorkbenchOptions{
		RepoRoot: app.RepoRoot,
		Port:     port,
		Build:    build,
	}, workbench.EnsureWorkbenchDeps{})
	if err != nil {
		return err
	}
	url := workbench.AppendRouteHash(handle.URL, route)
	if !noOpen {
		config.OpenInBrowser(url)
	}
	_, _ = fmt.Fprintf(cmd.OutOrStdout(), "herdr-workflows web · %s\n", url)
	if !handle.Owned {
		return nil
	}
	done := make(chan struct{}, 1)
	shutdown := func() {
		handle.Stop()
		select {
		case done <- struct{}{}:
		default:
		}
	}
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	engine.RetireOnCodeChange(shutdown, nil)
	go func() {
		<-sigCh
		shutdown()
	}()
	<-done
	return nil
}

func cmdHasTTY(cmd *cobra.Command) bool {
	in, okIn := cmd.InOrStdin().(*os.File)
	out, okOut := cmd.OutOrStdout().(*os.File)
	if !okIn || !okOut {
		return false
	}
	return term.IsTerminal(int(in.Fd())) && term.IsTerminal(int(out.Fd()))
}
