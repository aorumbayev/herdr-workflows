package cli

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestBuildPickerOptionsWiresLiveHooks(t *testing.T) {
	opts := buildPickerOptions(config.AppContext{RepoRoot: t.TempDir()}, nil)
	if opts.EditWorkflow != nil {
		t.Fatal("live EditWorkflow must stay nil so the picker uses tea.ExecProcess")
	}
	if opts.OpenURL == nil {
		t.Fatal("OpenURL must be wired")
	}
	if opts.Notify == nil {
		t.Fatal("Notify must be wired")
	}
	if opts.LaunchRun == nil {
		t.Fatal("LaunchRun must be wired")
	}
	if opts.AllocateRunID == nil {
		t.Fatal("AllocateRunID must be wired")
	}
	if opts.ExportShare == nil {
		t.Fatal("ExportShare must be wired")
	}
	if opts.Env == nil {
		t.Fatal("Env must be wired")
	}
	if opts.LoadWorkflow == nil {
		t.Fatal("LoadWorkflow must be wired")
	}
}

func TestBuildPickerOptionsExportShareCommand(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, ".hwf", "workflows")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := "version: v1alpha1\nsteps:\n  - run: [echo, hi]\n"
	if err := os.WriteFile(filepath.Join(dir, "demo.yaml"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	opts := buildPickerOptions(config.AppContext{RepoRoot: root}, nil)
	cmd, err := opts.ExportShare(workflow.ListEntry{Name: "demo", Source: "repo"})
	if err != nil {
		t.Fatalf("ExportShare: %v", err)
	}
	if !strings.HasPrefix(cmd, `hwf workflow import "`) {
		t.Fatalf("ExportShare command = %q", cmd)
	}
}

func TestPickerRejectsProtocolMismatchBeforeUI(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".hwf", "workflows"), 0o755); err != nil {
		t.Fatal(err)
	}
	sockPath := listenPingSocket(t, host.Protocol+1, host.MinHerdrVersion)
	got := runCLI([]string{"picker"}, root, testCLIEnv(t, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
		"HERDR_SOCKET_PATH":         sockPath,
	}), "")
	if got.code != 1 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if !strings.Contains(got.stderr, "herdr protocol mismatch") {
		t.Fatalf("stderr = %q", got.stderr)
	}
	if !strings.Contains(got.stderr, "pinned="+strconv.Itoa(host.Protocol)) {
		t.Fatalf("stderr = %q", got.stderr)
	}
}

func TestPickerRequiresTTYAfterProtocol(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".hwf", "workflows"), 0o755); err != nil {
		t.Fatal(err)
	}
	sockPath := listenPingSocket(t, host.Protocol, host.MinHerdrVersion)
	got := runCLI([]string{"picker"}, root, testCLIEnv(t, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
		"HERDR_SOCKET_PATH":         sockPath,
	}), "")
	if got.code != 1 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if !strings.Contains(got.stderr, "picker requires a tty") {
		t.Fatalf("stderr = %q", got.stderr)
	}
}

func TestCompiledBinaryPickerServesWithoutTSRuntime(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "herdr-workflows")
	build := exec.Command("go", "build", "-o", bin, "github.com/aorumbayev/herdr-workflows")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}

	data, err := os.ReadFile(bin)
	if err != nil {
		t.Fatal(err)
	}
	body := string(data)
	for _, want := range []string{
		"picker requires a tty",
		"Open the workflow picker popup",
		"enter run | ctrl+p actions | esc",
		"filter workflows...",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("compiled binary missing picker seam %q", want)
		}
	}
	for _, forbidden := range []string{
		"#!/usr/bin/env bun",
		"#!/usr/bin/env node",
		"bun run picker",
		"node_modules/.bin/tsx",
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("compiled binary embeds TS runtime hook %q", forbidden)
		}
	}

	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".hwf", "workflows"), 0o755); err != nil {
		t.Fatal(err)
	}
	sockPath := listenPingSocket(t, host.Protocol, host.MinHerdrVersion)
	env := testCLIEnv(t, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
		"HERDR_SOCKET_PATH":         sockPath,
		"PATH":                      "/usr/bin:/bin",
	})
	cmd := exec.Command(bin, "picker")
	cmd.Dir = root
	cmd.Env = flatEnv(env)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err = cmd.Run()
	if err == nil {
		t.Fatal("picker exited 0 without a tty")
	}
	ee, ok := err.(*exec.ExitError)
	if !ok || ee.ExitCode() != 1 {
		t.Fatalf("err = %v stderr = %q", err, stderr.String())
	}
	if !strings.Contains(stderr.String(), "picker requires a tty") {
		t.Fatalf("compiled picker stderr = %q", stderr.String())
	}
}

func flatEnv(extra map[string]string) []string {
	env := os.Environ()
	out := make([]string, 0, len(env)+len(extra))
	seen := map[string]bool{}
	for key, val := range extra {
		out = append(out, key+"="+val)
		seen[key] = true
	}
	for _, e := range env {
		key, _, _ := strings.Cut(e, "=")
		if seen[key] {
			continue
		}
		switch key {
		case "HERDR_SOCKET_PATH", "HERDR_PLUGIN_CONTEXT_JSON", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID":
			continue
		}
		out = append(out, e)
	}
	return out
}
