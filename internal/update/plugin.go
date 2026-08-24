package update

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	assets "github.com/aorumbayev/herdr-workflows/embed"
)

const ReleaseRepo = "aorumbayev/herdr-workflows"

type Result struct {
	Kind    string
	Current string
	From    string
	To      string
	Repo    string
	Code    int
}

type Deps struct {
	FetchLatest    func() (LatestRelease, error)
	RunInstall     func(args []string, cwd string) (int, error)
	PluginRoot     string
	Version        string
	ListSource     func() (PluginSourceInfo, error)
	Getenv         func(string) string
	Executable     func() (string, error)
	InstallRelease func(InstallOpts) error
}

func Plugin(deps Deps) (Result, error) {
	fetch := deps.FetchLatest
	if fetch == nil {
		fetch = func() (LatestRelease, error) { return CheckForUpdate(CheckOpts{}) }
	}
	latest, err := fetch()
	if err != nil {
		return Result{}, err
	}
	current := deps.Version
	if current == "" {
		current = assets.ManifestVersion()
	}
	cmp, err := CompareSemver(current, latest.Version)
	if err != nil {
		return Result{}, err
	}
	if cmp >= 0 {
		return Result{Kind: "up_to_date", Current: current}, nil
	}
	list := deps.ListSource
	if list == nil {
		return Result{}, fmt.Errorf("herdr plugin list failed: no source resolver")
	}
	source, err := list()
	if err != nil {
		return Result{}, err
	}
	if source.Kind == "local" {
		return Result{Kind: "refused_local"}, nil
	}
	if source.Kind == "unregistered" {
		return updateStandalone(deps, current, latest)
	}
	root := deps.PluginRoot
	if root == "" {
		root = defaultPluginRoot(deps.Getenv)
	}
	cwd, err := LeavePluginRoot(root, deps.Getenv)
	if err != nil {
		return Result{}, err
	}
	runInstall := deps.RunInstall
	if runInstall == nil {
		return Result{}, fmt.Errorf("install runner is required")
	}
	code, err := runInstall([]string{"plugin", "install", ReleaseRepo, "--ref", latest.Tag, "--yes"}, cwd)
	if err != nil {
		return Result{}, err
	}
	if code != 0 {
		return Result{Kind: "install_failed", From: current, To: latest.Version, Repo: ReleaseRepo, Code: code}, nil
	}
	return Result{Kind: "updated", From: current, To: latest.Version, Repo: ReleaseRepo}, nil
}

func updateStandalone(deps Deps, current string, latest LatestRelease) (Result, error) {
	execPath := deps.Executable
	if execPath == nil {
		execPath = os.Executable
	}
	dest, err := execPath()
	if err != nil {
		return Result{}, err
	}
	install := deps.InstallRelease
	if install == nil {
		install = InstallRelease
	}
	if err := install(InstallOpts{
		Version:  latest.Version,
		GOOS:     runtime.GOOS,
		GOARCH:   runtime.GOARCH,
		DestPath: dest,
	}); err != nil {
		return Result{}, err
	}
	return Result{Kind: "updated", From: current, To: latest.Version, Repo: ReleaseRepo}, nil
}

func defaultPluginRoot(getenv func(string) string) string {
	if getenv == nil {
		getenv = os.Getenv
	}
	if injected := strings.TrimSpace(getenv("HERDR_PLUGIN_ROOT")); injected != "" {
		return filepath.Clean(injected)
	}
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return wd
}

func LeavePluginRoot(pluginRoot string, getenv func(string) string) (string, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	home, _ := os.UserHomeDir()
	candidates := []string{home, os.TempDir(), getenv("HOME")}
	normalized := filepath.Clean(pluginRoot)
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		abs := filepath.Clean(candidate)
		if abs == normalized || strings.HasPrefix(abs, normalized+string(os.PathSeparator)) {
			continue
		}
		return abs, nil
	}
	parent := filepath.Dir(normalized)
	if parent != normalized {
		return parent, nil
	}
	return "", fmt.Errorf("cannot leave HERDR_PLUGIN_ROOT %s", pluginRoot)
}
