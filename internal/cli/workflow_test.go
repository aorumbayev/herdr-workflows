package cli

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	assets "github.com/aorumbayev/herdr-workflows/embed"
	"github.com/aorumbayev/herdr-workflows/internal/update"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

const updateNewer = "0.999.0"

func githubListJSON() string {
	return `{"id":"cli:plugin","result":{"type":"plugin_list","plugins":[{"plugin_id":"herdr-workflows","source":{"kind":"github","owner":"aorumbayev","repo":"herdr-workflows"}}]}}`
}

func localListJSON() string {
	return `{"id":"cli:plugin","result":{"type":"plugin_list","plugins":[{"plugin_id":"herdr-workflows","source":{"kind":"local"}}]}}`
}

func emptyListJSON() string {
	return `{"id":"cli:plugin","result":{"type":"plugin_list","plugins":[]}}`
}

func writeFakeHerdr(t *testing.T, pluginListJSON string) string {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "fake-herdr")
	script := "#!/bin/sh\nif [ \"$1\" = \"plugin\" ] && [ \"$2\" = \"list\" ]; then\n  printf '%s\\n' '" + pluginListJSON + "'\n  exit 0\nfi\nexit 1\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin
}

func captureExecuteUpdate(t *testing.T, deps updateDeps, extraEnv map[string]string) (stdout, stderr string, code int) {
	t.Helper()
	var outBuf, errBuf bytes.Buffer
	run := func() error {
		if deps.Getenv == nil {
			deps.Getenv = os.Getenv
		}
		return executeUpdate(deps, &outBuf, &errBuf)
	}
	var runErr error
	if extraEnv != nil {
		withEnv(extraEnv, func() int {
			runErr = run()
			return exitCodeFromErr(runErr)
		})
	} else {
		runErr = run()
	}
	if runErr != nil && errBuf.Len() == 0 {
		fmt.Fprintln(&errBuf, runErr.Error())
	}
	return outBuf.String(), errBuf.String(), exitCodeFromErr(runErr)
}

func exitCodeFromErr(err error) int {
	if err == nil {
		return 0
	}
	var ec *exitCodeError
	if errors.As(err, &ec) {
		return ec.ExitCode()
	}
	return 1
}

func TestWorkflowImportRejectsInvalidTo(t *testing.T) {
	root := t.TempDir()
	got := runCLI([]string{"workflow", "import", "x", "--to", "home", "--yes"}, root, nil, "")
	if got.code != 1 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if !strings.Contains(strings.ToLower(got.stderr), "invalid") && !strings.Contains(strings.ToLower(got.stderr), "choices") {
		t.Fatalf("stderr = %q", got.stderr)
	}
	if !strings.Contains(got.stderr, "home") {
		t.Fatalf("stderr = %q missing home", got.stderr)
	}
}

func TestWorkflowImportAcceptsToRepoWithYes(t *testing.T) {
	root := t.TempDir()
	yaml := "version: v1alpha1\nsteps:\n  - run: \"printf ok\"\n"
	payload, err := workflow.EncodePayload(workflow.WorkflowBundle{{Name: "imported", YAML: yaml}})
	if err != nil {
		t.Fatal(err)
	}
	got := runCLI([]string{"workflow", "import", payload, "--yes", "--to=repo"}, root, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
	}, "")
	if got.code != 0 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if !strings.Contains(got.stdout, "wrote") {
		t.Fatalf("stdout = %q", got.stdout)
	}
}

func TestWorkflowInspectHelpAndProtocolIndependence(t *testing.T) {
	root := t.TempDir()
	writeWorkflow(t, root, "inspect-me", strings.Join([]string{
		"version: v1alpha1",
		"inputs:",
		"  mode: [create, delete]",
		`  branch: { type: text, when: '{{inputs.mode}} == "create"' }`,
		"steps:",
		`  - run: [echo, "{{inputs.mode}}"]`,
		`  - run: [echo, "{{inputs.branch}}"]`,
		`    when: '{{inputs.mode}} == "create"'`,
		"",
	}, "\n"))

	help := runCLI([]string{"workflow", "inspect", "--help"}, root, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
	}, "")
	if help.code != 0 {
		t.Fatalf("help code = %d stderr = %q", help.code, help.stderr)
	}
	if !strings.Contains(help.stdout, "--input") || !strings.Contains(help.stdout, "--resolve") {
		t.Fatalf("help stdout = %q", help.stdout)
	}

	inspected := runCLI([]string{"workflow", "inspect", "inspect-me", "--input", "mode=create"}, root, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
		"HERDR_SOCKET_PATH":         "/tmp/hwf-missing-herdr.sock",
	}, "")
	if inspected.code != 0 {
		t.Fatalf("inspect code = %d stderr = %q", inspected.code, inspected.stderr)
	}
	if !strings.Contains(inspected.stdout, `when: {{inputs.mode}} == "create"`) {
		t.Fatalf("stdout = %q", inspected.stdout)
	}
	if !strings.Contains(inspected.stdout, "branch:") {
		t.Fatalf("stdout = %q", inspected.stdout)
	}
}

func TestWorkflowInspectResolveHonorsDependentChoicePrecondition(t *testing.T) {
	root := t.TempDir()
	writeWorkflow(t, root, "cascade", strings.Join([]string{
		"version: v1alpha1",
		"inputs:",
		"  repo: [alpha, beta]",
		"  branch:",
		"    type: choice",
		"    options:",
		`      run: [sh, -c, 'touch dependent-ran; echo "$1-main"', sh, "{{inputs.repo}}"]`,
		"  tag:",
		"    type: choice",
		"    options:",
		"      run: [echo, v1]",
		"steps:",
		`  - run: [echo, "{{inputs.branch}}", "{{inputs.tag}}"]`,
		"",
	}, "\n"))

	unresolved := runCLI([]string{"workflow", "inspect", "cascade", "--resolve"}, root, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
	}, "")
	if unresolved.code != 0 {
		t.Fatalf("unresolved code = %d stderr = %q", unresolved.code, unresolved.stderr)
	}
	if !strings.Contains(unresolved.stdout, `options.run: ["sh", "-c"`) {
		t.Fatalf("stdout = %q", unresolved.stdout)
	}
	if !strings.Contains(unresolved.stdout, `"{{inputs.repo}}"`) {
		t.Fatalf("stdout = %q", unresolved.stdout)
	}
	if strings.Contains(unresolved.stdout, `options: ["alpha-main"]`) {
		t.Fatalf("stdout = %q", unresolved.stdout)
	}
	if !strings.Contains(unresolved.stdout, `options: ["v1"]`) {
		t.Fatalf("stdout = %q", unresolved.stdout)
	}
	if _, err := os.Stat(filepath.Join(root, "dependent-ran")); err == nil {
		t.Fatal("dependent-ran should not exist")
	}

	resolved := runCLI([]string{"workflow", "inspect", "cascade", "--resolve", "--input", "repo=beta"}, root, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
	}, "")
	if resolved.code != 0 {
		t.Fatalf("resolved code = %d stderr = %q", resolved.code, resolved.stderr)
	}
	if !strings.Contains(resolved.stdout, `options: ["beta-main"]`) {
		t.Fatalf("stdout = %q", resolved.stdout)
	}
	if !strings.Contains(resolved.stdout, `options: ["v1"]`) {
		t.Fatalf("stdout = %q", resolved.stdout)
	}
	if _, err := os.Stat(filepath.Join(root, "dependent-ran")); err != nil {
		t.Fatalf("dependent-ran missing: %v", err)
	}
}

func TestUpdateNoOpsWhenCurrentOrNewer(t *testing.T) {
	current := assets.ManifestVersion()
	stdout, stderr, code := captureExecuteUpdate(t, updateDeps{
		FetchLatest: func() (update.LatestRelease, error) {
			return update.LatestRelease{Tag: "v" + current, Version: current}, nil
		},
	}, nil)
	if code != 0 || stderr != "" {
		t.Fatalf("code = %d stderr = %q", code, stderr)
	}
	if !strings.Contains(stdout, "already up to date ("+current+")") {
		t.Fatalf("stdout = %q", stdout)
	}
}

func TestUpdateRefusesLinkedDevelopmentCheckouts(t *testing.T) {
	herdr := writeFakeHerdr(t, localListJSON())
	stdout, stderr, code := captureExecuteUpdate(t, updateDeps{
		FetchLatest: func() (update.LatestRelease, error) {
			return update.LatestRelease{Tag: "v" + updateNewer, Version: updateNewer}, nil
		},
		ListSource: func() (update.PluginSourceInfo, error) {
			src, err := update.ParsePluginListSource(localListJSON())
			return src, err
		},
	}, map[string]string{"HERDR_BIN_PATH": herdr})
	if code != 1 {
		t.Fatalf("code = %d stdout = %q", code, stdout)
	}
	if !strings.Contains(stderr, "go run ./scripts/install-dev") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestUpdateExplainsUnregisteredBinaries(t *testing.T) {
	herdr := writeFakeHerdr(t, emptyListJSON())
	stdout, stderr, code := captureExecuteUpdate(t, updateDeps{
		FetchLatest: func() (update.LatestRelease, error) {
			return update.LatestRelease{Tag: "v" + updateNewer, Version: updateNewer}, nil
		},
		ListSource: func() (update.PluginSourceInfo, error) {
			src, err := update.ParsePluginListSource(emptyListJSON())
			return src, err
		},
	}, map[string]string{"HERDR_BIN_PATH": herdr})
	if code != 1 {
		t.Fatalf("code = %d stdout = %q", code, stdout)
	}
	if !strings.Contains(stderr, "herdr plugin install aorumbayev/herdr-workflows") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestUpdateLeavesPluginRootAndForwardsInstallFailure(t *testing.T) {
	herdr := writeFakeHerdr(t, githubListJSON())
	pluginRoot := t.TempDir()
	current := assets.ManifestVersion()
	var installs []struct {
		args []string
		cwd  string
	}
	stdout, stderr, code := captureExecuteUpdate(t, updateDeps{
		FetchLatest: func() (update.LatestRelease, error) {
			return update.LatestRelease{Tag: "v" + updateNewer, Version: updateNewer}, nil
		},
		ListSource: func() (update.PluginSourceInfo, error) {
			src, err := update.ParsePluginListSource(githubListJSON())
			return src, err
		},
		RunInstall: func(args []string, cwd string) (int, error) {
			installs = append(installs, struct {
				args []string
				cwd  string
			}{args: append([]string(nil), args...), cwd: cwd})
			return 7, nil
		},
		PluginRoot: pluginRoot,
	}, map[string]string{"HERDR_BIN_PATH": herdr, "HERDR_PLUGIN_ROOT": pluginRoot})
	if code != 7 {
		t.Fatalf("code = %d stdout = %q stderr = %q", code, stdout, stderr)
	}
	if len(installs) != 1 {
		t.Fatalf("installs = %#v", installs)
	}
	wantArgs := []string{"plugin", "install", "aorumbayev/herdr-workflows", "--ref", "v" + updateNewer, "--yes"}
	if strings.Join(installs[0].args, " ") != strings.Join(wantArgs, " ") {
		t.Fatalf("args = %#v want %#v", installs[0].args, wantArgs)
	}
	if installs[0].cwd == pluginRoot {
		t.Fatalf("cwd should leave plugin root, got %q", installs[0].cwd)
	}
	if !strings.Contains(stdout, "updating "+current+" → "+updateNewer) {
		t.Fatalf("stdout = %q", stdout)
	}
	if !strings.Contains(stderr, "exit 7") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestUpdateSuccessfulManagedInstall(t *testing.T) {
	herdr := writeFakeHerdr(t, githubListJSON())
	pluginRoot := t.TempDir()
	var installs []struct {
		args []string
		cwd  string
	}
	stdout, stderr, code := captureExecuteUpdate(t, updateDeps{
		FetchLatest: func() (update.LatestRelease, error) {
			return update.LatestRelease{Tag: "v" + updateNewer, Version: updateNewer}, nil
		},
		ListSource: func() (update.PluginSourceInfo, error) {
			src, err := update.ParsePluginListSource(githubListJSON())
			return src, err
		},
		RunInstall: func(args []string, cwd string) (int, error) {
			installs = append(installs, struct {
				args []string
				cwd  string
			}{args: append([]string(nil), args...), cwd: cwd})
			return 0, nil
		},
		PluginRoot: pluginRoot,
	}, map[string]string{"HERDR_BIN_PATH": herdr, "HERDR_PLUGIN_ROOT": pluginRoot})
	if code != 0 || stderr != "" {
		t.Fatalf("code = %d stderr = %q", code, stderr)
	}
	if len(installs) != 1 || !strings.Contains(strings.Join(installs[0].args, " "), "v"+updateNewer) {
		t.Fatalf("installs = %#v", installs)
	}
	if !strings.Contains(stdout, "updated to "+updateNewer) {
		t.Fatalf("stdout = %q", stdout)
	}
}

func TestUpdateFetchFailuresStayUpdateCheckErrors(t *testing.T) {
	stdout, stderr, code := captureExecuteUpdate(t, updateDeps{
		FetchLatest: func() (update.LatestRelease, error) {
			return update.CheckForUpdate(update.CheckOpts{
				URL:     "http://127.0.0.1:9",
				Timeout: 50 * time.Millisecond,
			})
		},
	}, nil)
	if code != 1 {
		t.Fatalf("code = %d stdout = %q", code, stdout)
	}
	if !strings.Contains(stderr, "update check failed:") {
		t.Fatalf("stderr = %q", stderr)
	}
	if strings.Contains(stderr, "update failed:") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestUpdateOtherFailuresUseUpdateFailed(t *testing.T) {
	herdr := writeFakeHerdr(t, emptyListJSON())
	script := "#!/bin/sh\necho 'plugin list exploded' >&2\nexit 3\n"
	if err := os.WriteFile(herdr, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := captureExecuteUpdate(t, updateDeps{
		FetchLatest: func() (update.LatestRelease, error) {
			return update.LatestRelease{Tag: "v" + updateNewer, Version: updateNewer}, nil
		},
		ListSource: func() (update.PluginSourceInfo, error) {
			return resolvePluginSource(func(key string) string {
				if key == "HERDR_BIN_PATH" {
					return herdr
				}
				return os.Getenv(key)
			})
		},
	}, map[string]string{"HERDR_BIN_PATH": herdr})
	if code != 1 {
		t.Fatalf("code = %d stdout = %q", code, stdout)
	}
	if !strings.Contains(stderr, "update failed:") || !strings.Contains(stderr, "herdr plugin list failed") {
		t.Fatalf("stderr = %q", stderr)
	}
	if strings.Contains(stderr, "update check failed:") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestUpdateHelp(t *testing.T) {
	root := t.TempDir()
	got := runCLI([]string{"update", "--help"}, root, map[string]string{
		"HERDR_BIN_PATH":    "/does-not-exist/herdr",
		"HERDR_SOCKET_PATH": "",
	}, "")
	if got.code != 0 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if !strings.Contains(got.stdout, "Update to the latest published GitHub Release") {
		t.Fatalf("stdout = %q", got.stdout)
	}
}
