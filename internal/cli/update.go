package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"

	assets "github.com/aorumbayev/herdr-workflows/embed"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/update"
)

type exitCodeError struct {
	code int
	msg  string
}

func (e *exitCodeError) Error() string { return e.msg }
func (e *exitCodeError) ExitCode() int { return e.code }

type updateDeps struct {
	FetchLatest    func() (update.LatestRelease, error)
	RunInstall     func(args []string, cwd string) (int, error)
	ListSource     func() (update.PluginSourceInfo, error)
	PluginRoot     string
	Version        string
	Getenv         func(string) string
	Executable     func() (string, error)
	InstallRelease func(update.InstallOpts) error
}

var pluginListMissingRE = regexp.MustCompile(`(?i)not found|no such|unknown plugin`)

func resolvePluginSource(getenv func(string) string) (update.PluginSourceInfo, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	herdr := host.BinPath(getenv)
	cmd := exec.Command(herdr, "plugin", "list", "--json", "--plugin", "herdr-workflows")
	cmd.Env = os.Environ()
	var stderrBuf strings.Builder
	cmd.Stderr = &stderrBuf
	out, err := cmd.Output()
	if err == nil {
		src, parseErr := update.ParsePluginListSource(string(out))
		if parseErr != nil {
			return update.PluginSourceInfo{}, parseErr
		}
		return src, nil
	}
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		return update.PluginSourceInfo{}, fmt.Errorf("herdr plugin list failed: %s", err.Error())
	}
	combined := stderrBuf.String() + string(out)
	if pluginListMissingRE.MatchString(combined) {
		return update.PluginSourceInfo{Kind: "unregistered"}, nil
	}
	msg := strings.TrimSpace(combined)
	if msg == "" {
		msg = fmt.Sprintf("exit %d", exitErr.ExitCode())
	}
	return update.PluginSourceInfo{}, fmt.Errorf("herdr plugin list failed: %s", msg)
}

func defaultHerdrInstall(getenv func(string) string) func([]string, string) (int, error) {
	return func(args []string, cwd string) (int, error) {
		herdr := host.BinPath(getenv)
		cmd := exec.Command(herdr, args...)
		cmd.Dir = cwd
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.Stdin = os.Stdin
		cmd.Env = os.Environ()
		err := cmd.Run()
		if err == nil {
			return 0, nil
		}
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode(), nil
		}
		return 0, err
	}
}

func pluginRootFor(getenv func(string) string) string {
	execPath, _ := os.Executable()
	cwd, _ := os.Getwd()
	return resolvePluginRoot(getenv, execPath, cwd)
}

func defaultUpdateDeps() updateDeps {
	getenv := os.Getenv
	return updateDeps{
		FetchLatest:    func() (update.LatestRelease, error) { return update.CheckForUpdate(update.CheckOpts{}) },
		RunInstall:     defaultHerdrInstall(getenv),
		ListSource:     func() (update.PluginSourceInfo, error) { return resolvePluginSource(getenv) },
		PluginRoot:     pluginRootFor(getenv),
		Version:        assets.ManifestVersion(),
		Getenv:         getenv,
		Executable:     os.Executable,
		InstallRelease: update.InstallRelease,
	}
}

func refVersionFromInstallArgs(args []string) string {
	for i := 0; i < len(args)-1; i++ {
		if args[i] == "--ref" {
			tag := strings.TrimPrefix(args[i+1], "v")
			return tag
		}
	}
	return ""
}

func executeUpdate(deps updateDeps, stdout, stderr io.Writer) error {
	if deps.Getenv == nil {
		deps.Getenv = os.Getenv
	}
	if deps.FetchLatest == nil {
		deps.FetchLatest = func() (update.LatestRelease, error) { return update.CheckForUpdate(update.CheckOpts{}) }
	}
	if deps.ListSource == nil {
		deps.ListSource = func() (update.PluginSourceInfo, error) { return resolvePluginSource(deps.Getenv) }
	}
	if deps.RunInstall == nil {
		deps.RunInstall = defaultHerdrInstall(deps.Getenv)
	}
	if deps.Executable == nil {
		deps.Executable = os.Executable
	}
	if deps.InstallRelease == nil {
		deps.InstallRelease = update.InstallRelease
	}
	if deps.PluginRoot == "" {
		deps.PluginRoot = pluginRootFor(deps.Getenv)
	}
	current := deps.Version
	if current == "" {
		current = assets.ManifestVersion()
	}
	origInstall := deps.RunInstall
	deps.RunInstall = func(args []string, cwd string) (int, error) {
		to := refVersionFromInstallArgs(args)
		if to == "" {
			to = "?"
		}
		if _, err := fmt.Fprintf(stdout, "updating %s → %s via herdr plugin install %s\n", current, to, update.ReleaseRepo); err != nil {
			return 0, err
		}
		return origInstall(args, cwd)
	}
	origStandalone := deps.InstallRelease
	deps.InstallRelease = func(opts update.InstallOpts) error {
		if _, err := fmt.Fprintf(stdout, "updating %s → %s via standalone binary replace\n", current, opts.Version); err != nil {
			return err
		}
		return origStandalone(opts)
	}
	result, err := update.UpdatePlugin(update.Deps{
		FetchLatest:    deps.FetchLatest,
		RunInstall:     deps.RunInstall,
		ListSource:     deps.ListSource,
		PluginRoot:     deps.PluginRoot,
		Version:        current,
		Getenv:         deps.Getenv,
		Executable:     deps.Executable,
		InstallRelease: deps.InstallRelease,
	})
	if err != nil {
		msg := err.Error()
		var checkErr *update.ReleaseCheckError
		if errors.As(err, &checkErr) {
			return fmt.Errorf("update check failed: %s", msg)
		}
		return fmt.Errorf("update failed: %s", msg)
	}
	return presentUpdateResult(result, stdout, stderr)
}

func presentUpdateResult(result update.Result, stdout, stderr io.Writer) error {
	switch result.Kind {
	case "up_to_date":
		if _, err := fmt.Fprintf(stdout, "already up to date (%s)\n", result.Current); err != nil {
			return err
		}
		return nil
	case "refused_local":
		return fmt.Errorf("refusing to update a linked development checkout — run go run ./scripts/install-dev from the working tree instead")
	case "refused_unregistered":
		return fmt.Errorf("standalone update refused")
	case "updated":
		if _, err := fmt.Fprintf(stdout, "updated to %s\n", result.To); err != nil {
			return err
		}
		return nil
	case "install_failed":
		msg := fmt.Sprintf("herdr plugin install failed with exit %d", result.Code)
		if _, err := fmt.Fprintln(stderr, msg); err != nil {
			return err
		}
		return &exitCodeError{code: result.Code, msg: msg}
	default:
		return fmt.Errorf("update failed: unknown result kind %q", result.Kind)
	}
}
