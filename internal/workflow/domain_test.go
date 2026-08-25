package workflow

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/config"
)

func writeDomainWorkflow(t *testing.T, root, name, body string) {
	t.Helper()
	dir := filepath.Join(root, ".hwf", "workflows")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name+".yaml"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestDefinitionValidatesReferencesAndChildren(t *testing.T) {
	root := t.TempDir()
	writeDomainWorkflow(t, root, "child", `version: v1alpha1
inputs:
  base: text
returns:
  findings: "{{steps.review}}"
steps:
  - id: review
    agent: "review {{inputs.base}}"
`)
	writeDomainWorkflow(t, root, "parent", `version: v1alpha1
steps:
  - id: call
    workflow: child
    inputs: {base: repo}
  - run: [echo, "{{steps.call.findings.response}}"]
`)
	wf, err := LoadWorkflow("parent", root, config.Config{Profiles: map[string]config.Profile{}, Transcripts: map[string]config.TranscriptExtractor{}})
	if err != nil {
		t.Fatal(err)
	}
	if wf.Children["child"] == nil || wf.Children["child"].Returns == nil {
		t.Fatalf("child graph not retained: %#v", wf.Children)
	}

	writeDomainWorkflow(t, root, "bad", `version: v1alpha1
steps:
  - id: maybe
    run: [echo, hi]
    when: "{{inputs.mode}}"
  - run: [echo, "{{steps.maybe.stdout}}"]
`)
	_, err = LoadWorkflow("bad", root, config.Config{})
	if err == nil || !strings.Contains(err.Error(), "unknown input 'mode'") {
		t.Fatalf("got %v, want unknown input error", err)
	}
}

func TestDefinitionRejectsCyclesAndUnprovenResults(t *testing.T) {
	root := t.TempDir()
	writeDomainWorkflow(t, root, "a", "version: v1alpha1\nsteps:\n  - workflow: b\n")
	writeDomainWorkflow(t, root, "b", "version: v1alpha1\nsteps:\n  - workflow: a\n")
	_, err := LoadWorkflow("a", root, config.Config{})
	if err == nil || !strings.Contains(err.Error(), "workflow cycle: a → b → a") {
		t.Fatalf("got %v, want cycle", err)
	}

	_, err = ParseWorkflowText("guard", `version: v1alpha1
inputs:
  mode: [create, delete]
steps:
  - id: probe
    run: [echo, hi]
    when: '{{inputs.mode}} == "create"'
  - run: [echo, "{{steps.probe.stdout}}"]
`, config.Config{}, root)
	if err == nil || !strings.Contains(err.Error(), "not proven available") {
		t.Fatalf("got %v, want guard error", err)
	}
}

func TestInputSessionCollectsDynamicChoicesAndInvalidatesDependents(t *testing.T) {
	root := t.TempDir()
	script := filepath.Join(root, "branches.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf '%s-main\\n' \"$1\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	resolve := true
	session := NewInputSession(InputSessionOptions{
		Specs: []InputSpec{
			{Name: "repo", Type: "choice", Options: []string{"alpha", "beta"}},
			{Name: "branch", Type: "choice", DynamicOptions: &DynamicChoice{Run: []string{"sh", script, "{{inputs.repo}}"}}},
		},
		File: "workflow.yaml", RepoRoot: root, ResolveDynamic: &resolve,
	})
	current := session.Current(context.Background())
	if current.Prompt == nil || current.Prompt.Spec.Name != "repo" {
		t.Fatalf("first prompt: %#v", current)
	}
	if err := session.Answer("beta"); err != nil {
		t.Fatal(err)
	}
	current = session.Current(context.Background())
	if current.Prompt == nil || !slicesEqual(current.Prompt.Options, []string{"beta-main"}) {
		t.Fatalf("dynamic prompt: %#v", current)
	}
	if err := session.Answer("beta-main"); err != nil {
		t.Fatal(err)
	}
	collected, err := session.Result()
	if err != nil || collected.Values["branch"] != "beta-main" {
		t.Fatalf("collected = %#v, err = %v", collected, err)
	}
	if !session.Back() {
		t.Fatal("expected back navigation")
	}
	if !session.Back() {
		t.Fatal("expected back navigation")
	}
	if len(session.Domains()) != 0 {
		t.Fatalf("dependent domain survived back navigation: %#v", session.Domains())
	}
}

func TestInputSessionBacktrackInvalidatesLaterAnswers(t *testing.T) {
	session := NewInputSession(InputSessionOptions{
		Specs: []InputSpec{
			{Name: "mode", Type: "choice", Options: []string{"create", "delete"}},
			{Name: "branch", Type: "choice", Options: []string{"main", "dev"}},
			{Name: "note", Type: "text"},
		},
		File: "x.yaml",
	})
	for _, answer := range []string{"create", "main", "hello"} {
		if cur := session.Current(context.Background()); cur.Prompt == nil {
			t.Fatalf("expected prompt before %q: %#v", answer, cur)
		}
		if err := session.Answer(answer); err != nil {
			t.Fatal(err)
		}
	}
	if !session.Back() || !mapsEqual(session.Values(), map[string]string{"mode": "create", "branch": "main", "note": "hello"}) {
		t.Fatalf("first back should keep all values: %#v", session.Values())
	}
	if !session.Back() || !mapsEqual(session.Values(), map[string]string{"mode": "create", "branch": "main"}) {
		t.Fatalf("second back should clear note: %#v", session.Values())
	}
	if !session.Back() || !mapsEqual(session.Values(), map[string]string{"mode": "create"}) {
		t.Fatalf("third back should clear branch: %#v", session.Values())
	}
	cur := session.Current(context.Background())
	if cur.Prompt == nil || cur.Prompt.Spec.Name != "mode" {
		t.Fatalf("next prompt should reopen mode: %#v", cur)
	}
	if err := session.Answer("delete"); err != nil {
		t.Fatal(err)
	}
	values := session.Values()
	if values["mode"] != "delete" {
		t.Fatalf("mode = %q", values["mode"])
	}
	if _, ok := values["branch"]; ok {
		t.Fatal("branch should be cleared")
	}
	if _, ok := values["note"]; ok {
		t.Fatal("note should be cleared")
	}
}

func TestInputSessionRejectsOutOfDomainChoice(t *testing.T) {
	session := NewInputSession(InputSessionOptions{
		Specs: []InputSpec{{Name: "mode", Type: "choice", Options: []string{"fast", "full"}}},
		File:  "x.yaml",
	})
	if cur := session.Current(context.Background()); cur.Prompt == nil {
		t.Fatal("expected prompt")
	}
	if err := session.Answer("turbo"); err == nil || !strings.Contains(err.Error(), "must be one of: fast, full") {
		t.Fatalf("out-of-domain err = %v", err)
	}
	if err := session.Answer("fast"); err != nil {
		t.Fatal(err)
	}
}

func TestInputSessionAllowCustomAndMinLength(t *testing.T) {
	minimum := 1
	custom := NewInputSession(InputSessionOptions{
		Specs: []InputSpec{{Name: "branch", Type: "choice", Options: []string{"main"}, AllowCustom: true, MinLength: &minimum}},
		File:  "x.yaml",
	})
	if cur := custom.Current(context.Background()); cur.Prompt == nil {
		t.Fatal("expected prompt")
	}
	if err := custom.Answer("feature/x"); err != nil {
		t.Fatal(err)
	}
	collected, err := custom.Result()
	if err != nil || collected.Values["branch"] != "feature/x" {
		t.Fatalf("collected = %#v, err = %v", collected, err)
	}

	minimum = 2
	short := NewInputSession(InputSessionOptions{
		Specs: []InputSpec{{Name: "note", Type: "text", MinLength: &minimum}},
		File:  "x.yaml",
	})
	if cur := short.Current(context.Background()); cur.Prompt == nil {
		t.Fatal("expected prompt")
	}
	if err := short.Answer("a"); err == nil || !strings.Contains(err.Error(), "must be at least 2 characters") {
		t.Fatalf("short answer err = %v", err)
	}
}

func TestInputSessionCancelPendingIgnoresLateResolution(t *testing.T) {
	// Ports test/workflows/input-session.test.ts "cancelPending ignores late dynamic option resolution".
	root := t.TempDir()
	script := filepath.Join(root, "slow.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nsleep 0.2\necho one\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	resolve := true
	session := NewInputSession(InputSessionOptions{
		Specs: []InputSpec{{
			Name: "branch", Type: "choice",
			DynamicOptions: &DynamicChoice{Run: []string{"sh", script}},
		}},
		File: filepath.Join(root, "x.yaml"), RepoRoot: root, ResolveDynamic: &resolve,
	})
	done := make(chan CurrentResult, 1)
	go func() { done <- session.Current(context.Background()) }()
	time.Sleep(50 * time.Millisecond)
	session.CancelPending()
	cur := <-done
	if !cur.Cancelled {
		t.Fatalf("want cancelled, got %#v", cur)
	}
	if len(session.Domains()) != 0 {
		t.Fatalf("domains = %#v", session.Domains())
	}
}

func TestInputSessionSuppliedDomainsSurviveEarlierAnswers(t *testing.T) {
	resolve := false
	session := NewInputSession(InputSessionOptions{
		Specs: []InputSpec{
			{Name: "mode", Type: "choice", Options: []string{"create", "delete"}},
			{
				Name: "ref", Type: "choice",
				DynamicOptions: &DynamicChoice{Run: []string{"sh", "-c", "echo main"}},
				When:           []WhenSpec{{Kind: WhenEqual, Path: "inputs.mode", Value: "create"}},
			},
		},
		File: "x.yaml", Domains: map[string][]string{"ref": {"main"}}, ResolveDynamic: &resolve,
	})
	collected, err := session.CompleteFromProvided(context.Background(), map[string]string{"mode": "create", "ref": "main"})
	if err != nil || !mapsEqual(collected.Values, map[string]string{"mode": "create", "ref": "main"}) {
		t.Fatalf("collected = %#v, err = %v", collected, err)
	}
	if !slicesEqual(collected.Domains["ref"], []string{"main"}) {
		t.Fatalf("domains = %#v", collected.Domains)
	}
}

func mapsEqual(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

func TestDumpWorkflowPreservesInputOrderAndSchemaFields(t *testing.T) {
	raw, err := ParseRaw("dump.yaml", `version: v1alpha1
inputs:
  mode: [create, delete]
  branch:
    type: text
    when: '{{inputs.mode}} == "create"'
steps:
  - id: server
    run: [echo, ready]
    pane:
      open: tab
      name: "server {{inputs.mode}}"
    ready_when: /ready/
    timeout: 5s
`)
	if err != nil {
		t.Fatal(err)
	}
	dumped, err := DumpWorkflow(raw)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseRaw("dumped.yaml", dumped)
	if err != nil {
		t.Fatalf("dumped workflow does not parse: %s\n%s", err, dumped)
	}
	if len(parsed.Inputs) != 2 || parsed.Inputs[0].Name != "mode" || parsed.Inputs[1].Name != "branch" {
		t.Fatalf("input order changed: %#v", parsed.Inputs)
	}
	run := parsed.Steps[0].Action.(RunAction)
	if run.Pane == nil || run.Pane.Name == "" || run.Pane.Anchor != "" || run.ReadyWhen != "ready" {
		t.Fatalf("pane fields did not round trip: %#v", run)
	}
}

func TestChildInputMembershipContract(t *testing.T) {
	const choiceChild = `version: v1alpha1
inputs:
  mode: [fast, slow]
steps:
  - run: 'echo "$HWF_mode"'
`
	const guardedChild = `version: v1alpha1
inputs:
  mode: [fast, slow]
  extra:
    type: text
    when: '{{inputs.mode}} == "slow"'
steps:
  - run: 'echo "$HWF_extra"'
    when: '{{inputs.mode}} == "slow"'
  - run: 'echo "$HWF_mode"'
`
	tests := []struct {
		name   string
		child  string
		parent string
		want   string
	}{
		{"passes an input the child never declares", choiceChild, `version: v1alpha1
steps:
  - workflow: child
    inputs: {mode: fast, extra: x}
`, "step 1, inputs.extra: unknown child input 'extra'"},
		{"omits a child input with no default", choiceChild, `version: v1alpha1
steps:
  - workflow: child
`, "step 1, inputs.mode: missing required child input 'mode'"},
		{"passes a value outside the child options", choiceChild, `version: v1alpha1
steps:
  - workflow: child
    inputs: {mode: turbo}
`, "step 1, inputs.mode: child input 'mode' must be one of: fast, slow"},
		{"passes a whole step result", choiceChild, `version: v1alpha1
steps:
  - id: probe
    agent: hi
    expect: {one_of: [A, B]}
  - workflow: child
    inputs: {mode: "{{steps.probe}}"}
`, "step 2, inputs.mode: child input 'mode' must resolve to text (source type object)"},
		{"passes an unmerged profile name", `version: v1alpha1
inputs:
  who: profile
steps:
  - agent: hi
    using: "{{inputs.who}}"
`, `version: v1alpha1
steps:
  - workflow: child
    inputs: {who: nobody}
`, "step 1, inputs.who: child input 'who' must name a merged profile"},
		{"omits a child input that carries a default", `version: v1alpha1
inputs:
  mode:
    type: text
    default: fast
steps:
  - run: 'echo "$HWF_mode"'
`, `version: v1alpha1
steps:
  - workflow: child
`, ""},
		{"omits a child input that is provably inactive", guardedChild, `version: v1alpha1
steps:
  - workflow: child
    inputs: {mode: fast}
`, ""},
	}
	cfg := config.Config{
		Profiles:       map[string]config.Profile{"claude": {Kind: "claude"}},
		DefaultProfile: "claude",
		Transcripts:    map[string]config.TranscriptExtractor{},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			writeDomainWorkflow(t, root, "child", tc.child)
			writeDomainWorkflow(t, root, "parent", tc.parent)
			_, err := LoadWorkflow("parent", root, cfg)
			if tc.want == "" {
				if err != nil {
					t.Fatalf("LoadWorkflow: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want error containing %q", err, tc.want)
			}
		})
	}
}
