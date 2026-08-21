package cli

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"testing"

	assets "github.com/aorumbayev/herdr-workflows/embed"
	"github.com/aorumbayev/herdr-workflows/internal/host"
)

type cliResult struct {
	stdout string
	stderr string
	code   int
}

func runCLI(args []string, cwd string, extraEnv map[string]string, stdin string) cliResult {
	var in io.Reader = bytes.NewBufferString(stdin)
	if stdin == "" {
		in = bytes.NewBuffer(nil)
	}
	var stdout, stderr bytes.Buffer
	code := withEnv(extraEnv, func() int {
		if cwd != "" {
			prev, err := os.Getwd()
			if err != nil {
				panic(err)
			}
			if err := os.Chdir(cwd); err != nil {
				panic(err)
			}
			defer func() { _ = os.Chdir(prev) }()
		}
		return Main(args, in, &stdout, &stderr)
	})
	return cliResult{stdout: stdout.String(), stderr: stderr.String(), code: code}
}

func withEnv(extra map[string]string, fn func() int) int {
	host.ResetProtocolCheck()
	prev := map[string]*string{}
	unset := []string{
		"HERDR_SOCKET_PATH",
		"HERDR_PLUGIN_CONTEXT_JSON",
		"HERDR_PANE_ID",
		"HERDR_TAB_ID",
		"HERDR_WORKSPACE_ID",
	}
	for _, key := range unset {
		if extra != nil {
			if _, ok := extra[key]; ok {
				continue
			}
		}
		if v, ok := os.LookupEnv(key); ok {
			cp := v
			prev[key] = &cp
		} else {
			prev[key] = nil
		}
		_ = os.Unsetenv(key)
	}
	for key, val := range extra {
		if v, ok := os.LookupEnv(key); ok {
			cp := v
			prev[key] = &cp
		} else if _, seen := prev[key]; !seen {
			prev[key] = nil
		}
		if val == "" {
			_ = os.Unsetenv(key)
		} else {
			_ = os.Setenv(key, val)
		}
	}
	defer func() {
		for key, val := range prev {
			if val == nil {
				_ = os.Unsetenv(key)
			} else {
				_ = os.Setenv(key, *val)
			}
		}
	}()
	return fn()
}

func writeWorkflow(t *testing.T, root, name, body string) {
	t.Helper()
	dir := filepath.Join(root, ".hwf", "workflows")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name+".yaml"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestNoArgsWithoutTTYPrintsHelpOnStderr(t *testing.T) {
	root := t.TempDir()
	got := runCLI(nil, root, nil, "")
	if got.code != 1 {
		t.Fatalf("code = %d, stderr = %q", got.code, got.stderr)
	}
	if !bytes.Contains([]byte(got.stderr), []byte("Usage:")) {
		t.Fatalf("stderr %q missing Usage:", got.stderr)
	}
	if !bytes.Contains([]byte(got.stderr), []byte("run")) {
		t.Fatalf("stderr %q missing run", got.stderr)
	}
	if !bytes.Contains([]byte(got.stderr), []byte("web")) {
		t.Fatalf("stderr %q missing web", got.stderr)
	}
	if got.stdout != "" {
		t.Fatalf("stdout = %q", got.stdout)
	}
}

func TestHelpPrintsRootHelp(t *testing.T) {
	root := t.TempDir()
	got := runCLI([]string{"help"}, root, nil, "")
	if got.code != 0 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	for _, want := range []string{"Usage:", "Commands:", "run", "web", assets.ManifestDescription(), "Workflow format: v1alpha1"} {
		if !bytes.Contains([]byte(got.stdout), []byte(want)) {
			t.Fatalf("stdout %q missing %q", got.stdout, want)
		}
	}
}

func TestVersionFlagsPrintManifestVersion(t *testing.T) {
	root := t.TempDir()
	want := assets.ManifestVersion()
	for _, flag := range []string{"--version", "-V"} {
		got := runCLI([]string{flag}, root, nil, "")
		if got.code != 0 || got.stderr != "" {
			t.Fatalf("%s code=%d stderr=%q", flag, got.code, got.stderr)
		}
		if got.stdout != want+"\n" && got.stdout != want {
			t.Fatalf("%s stdout = %q want %q", flag, got.stdout, want)
		}
	}
}

func TestRunHelp(t *testing.T) {
	root := t.TempDir()
	for _, args := range [][]string{{"run", "--help"}, {"help", "run"}} {
		got := runCLI(args, root, nil, "")
		if got.code != 0 {
			t.Fatalf("%v code=%d stderr=%q", args, got.code, got.stderr)
		}
		for _, want := range []string{"Usage:", "--input", "--launch-payload"} {
			if !bytes.Contains([]byte(got.stdout), []byte(want)) {
				t.Fatalf("%v stdout %q missing %q", args, got.stdout, want)
			}
		}
	}
}

func TestUnknownCommand(t *testing.T) {
	root := t.TempDir()
	nope := runCLI([]string{"nope"}, root, nil, "")
	if nope.code != 1 {
		t.Fatalf("code = %d", nope.code)
	}
	if !bytes.Contains([]byte(nope.stderr), []byte("unknown command")) || !bytes.Contains([]byte(nope.stderr), []byte("nope")) {
		t.Fatalf("stderr = %q", nope.stderr)
	}
	typo := runCLI([]string{"inti"}, root, nil, "")
	if typo.code != 1 {
		t.Fatalf("code = %d", typo.code)
	}
	if !bytes.Contains([]byte(typo.stderr), []byte("unknown command")) || !bytes.Contains([]byte(typo.stderr), []byte("inti")) {
		t.Fatalf("stderr = %q", typo.stderr)
	}
	if !bytes.Contains([]byte(typo.stderr), []byte("init")) {
		t.Fatalf("missing suggestion in %q", typo.stderr)
	}
}

func TestUnknownOption(t *testing.T) {
	root := t.TempDir()
	writeWorkflow(t, root, "hi", "version: v1alpha1\nsteps:\n  - run: \"printf ok\"\n")
	got := runCLI([]string{"run", "hi", "--not-a-real-flag"}, root, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
	}, "")
	if got.code != 1 {
		t.Fatalf("code = %d stderr=%q", got.code, got.stderr)
	}
	if !bytes.Contains([]byte(got.stderr), []byte("unknown option")) {
		t.Fatalf("stderr = %q", got.stderr)
	}
}

func TestRunMissingName(t *testing.T) {
	root := t.TempDir()
	got := runCLI([]string{"run"}, root, nil, "")
	if got.code != 1 {
		t.Fatalf("code = %d", got.code)
	}
	if !bytes.Contains([]byte(got.stderr), []byte("missing required argument")) {
		t.Fatalf("stderr = %q", got.stderr)
	}
}

func TestWorkflowWithoutSubcommandPrintsHelp(t *testing.T) {
	root := t.TempDir()
	got := runCLI([]string{"workflow"}, root, nil, "")
	if got.code != 1 {
		t.Fatalf("code = %d", got.code)
	}
	if !bytes.Contains([]byte(got.stderr), []byte("Usage:")) || !bytes.Contains([]byte(got.stderr), []byte("import")) {
		t.Fatalf("stderr = %q", got.stderr)
	}
}
