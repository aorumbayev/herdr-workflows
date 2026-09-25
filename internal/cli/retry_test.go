package cli

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var claimedRe = regexp.MustCompile(`@hwf-history:claimed ([0-9a-f-]{36})`)

const flakyWorkflow = `version: v1alpha1
inputs:
  who: text
steps:
  - id: probe
    run: [sh, -c, 'echo x >> count; printf "%s" "$1"', sh, "{{inputs.who}}"]
  - run: [sh, -c, 'test -f fixed && printf "%s" "$1" > out.txt', sh, "{{steps.probe.stdout}}"]
`

type retryEnv struct {
	root string
	env  map[string]string
}

func newRetryEnv(t *testing.T, body string) retryEnv {
	t.Helper()
	root := t.TempDir()
	state := t.TempDir()
	if err := os.Chmod(state, 0o700); err != nil {
		t.Fatal(err)
	}
	writeWorkflow(t, root, "flaky", body)
	return retryEnv{root: root, env: map[string]string{
		"HOME":                      t.TempDir(),
		"HERDR_PLUGIN_CONFIG_DIR":   t.TempDir(),
		"HERDR_PLUGIN_STATE_DIR":    state,
		"HERDR_WORKFLOWS_REPO_ROOT": root,
	}}
}

func (e retryEnv) run(args []string, stdin string) cliResult {
	return runCLI(args, e.root, e.env, stdin)
}

func (e retryEnv) failFirst(t *testing.T) string {
	t.Helper()
	got := e.run([]string{"run", "flaky", "--input", "who=ada"}, "")
	if got.code != 1 {
		t.Fatalf("first run code = %d stderr = %q", got.code, got.stderr)
	}
	m := claimedRe.FindStringSubmatch(got.stdout)
	if m == nil {
		t.Fatalf("no claimed run id in %q", got.stdout)
	}
	if err := os.WriteFile(filepath.Join(e.root, "fixed"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	return m[1]
}

func (e retryEnv) read(t *testing.T, name string) string {
	t.Helper()
	body, err := os.ReadFile(filepath.Join(e.root, name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(body)
}

func TestRetryFromFailedReusesFinishedStepsAndRecordedInputs(t *testing.T) {
	e := newRetryEnv(t, flakyWorkflow)
	id := e.failFirst(t)

	got := e.run([]string{"retry", id, "--from-failed"}, "")
	if got.code != 0 {
		t.Fatalf("retry code = %d stderr = %q", got.code, got.stderr)
	}
	if !strings.Contains(got.stdout, "[1/2] probe reused") {
		t.Fatalf("stdout = %q, want reused progress", got.stdout)
	}
	if n := strings.Count(e.read(t, "count"), "x"); n != 1 {
		t.Fatalf("probe ran %d times, want 1", n)
	}
	if out := e.read(t, "out.txt"); out != "ada" {
		t.Fatalf("out.txt = %q, want ada", out)
	}
}

func TestRetryAllRerunsEveryStepWithRecordedInputs(t *testing.T) {
	e := newRetryEnv(t, flakyWorkflow)
	id := e.failFirst(t)

	got := e.run([]string{"retry", id}, "")
	if got.code != 0 {
		t.Fatalf("retry code = %d stderr = %q", got.code, got.stderr)
	}
	if n := strings.Count(e.read(t, "count"), "x"); n != 2 {
		t.Fatalf("probe ran %d times, want 2", n)
	}
	if out := e.read(t, "out.txt"); out != "ada" {
		t.Fatalf("out.txt = %q, want ada", out)
	}
}

func TestRetryFromFailedRefusesAnEditedEarlierStep(t *testing.T) {
	e := newRetryEnv(t, flakyWorkflow)
	id := e.failFirst(t)
	writeWorkflow(t, e.root, "flaky", strings.Replace(flakyWorkflow, "echo x >> count", "echo y >> count", 1))

	got := e.run([]string{"retry", id, "--from-failed"}, "")
	if got.code != 1 || !strings.Contains(got.stderr, "step 1 (probe) changed") {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
}

func TestRetryRefusesAnotherCheckout(t *testing.T) {
	e := newRetryEnv(t, flakyWorkflow)
	id := e.failFirst(t)
	other := t.TempDir()
	writeWorkflow(t, other, "flaky", flakyWorkflow)
	e.env["HERDR_WORKFLOWS_REPO_ROOT"] = other

	got := runCLI([]string{"retry", id}, other, e.env, "")
	if got.code != 1 || !strings.Contains(got.stderr, "run it from") {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
}

func TestRetryRefusesUnknownRun(t *testing.T) {
	e := newRetryEnv(t, flakyWorkflow)
	got := e.run([]string{"retry", "00000000-0000-4000-8000-000000000009"}, "")
	if got.code != 1 || !strings.Contains(got.stderr, "not found") {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
}

func TestRetryLaunchPayloadResumesTheRecordedRun(t *testing.T) {
	e := newRetryEnv(t, flakyWorkflow)
	id := e.failFirst(t)

	got := e.run([]string{"run", "flaky", "--launch-payload"}, `{"name":"flaky","inputs":{},"retryOf":"`+id+`","fromFailed":true}`)
	if got.code != 0 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if n := strings.Count(e.read(t, "count"), "x"); n != 1 {
		t.Fatalf("probe ran %d times, want 1", n)
	}
}

func TestRetryLaunchPayloadRejectsAnotherWorkflowName(t *testing.T) {
	e := newRetryEnv(t, flakyWorkflow)
	id := e.failFirst(t)
	writeWorkflow(t, e.root, "other", "version: v1alpha1\nsteps:\n  - run: [echo, hi]\n")

	got := e.run([]string{"run", "other", "--launch-payload"}, `{"name":"other","inputs":{},"retryOf":"`+id+`"}`)
	if got.code != 1 || !strings.Contains(got.stderr, "belongs to workflow 'flaky'") {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
}
