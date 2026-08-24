package workflow

import (
	"strings"
	"testing"
	"time"
)

func TestDocumentIsParsedAuthoringValue(t *testing.T) {
	var doc Document
	parsed, err := ParseRaw("test.yaml", "version: v1alpha1\nsteps:\n  - run: \"true\"\n")
	if err != nil {
		t.Fatal(err)
	}
	doc = parsed
	if doc.Version != Format || len(doc.Steps) != 1 {
		t.Fatalf("unexpected document: %#v", doc)
	}
}

func mustParse(t *testing.T, text string) Document {
	t.Helper()
	raw, err := ParseRaw("test.yaml", text)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func mustReject(t *testing.T, text, want string) {
	t.Helper()
	_, err := ParseRaw("test.yaml", text)
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("got %v, want error containing %q", err, want)
	}
}

func TestParseRawGrammar(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{"unsupported alpha", "version: v1alpha2\nsteps:\n  - run: \"true\"\n", "unsupported workflow format 'v1alpha2'"},
		{"missing version", "steps:\n  - run: \"true\"\n", "version is required"},
		{"missing steps", "version: v1alpha1\n", "steps is required"},
		{"unknown top-level key", "version: v1alpha1\nretries: 3\nsteps:\n  - run: \"true\"\n", `Unrecognized key: "retries"`},
		{"empty steps", "version: v1alpha1\nsteps: []\n", "expected array to have >=1 items"},
		{"multiple actions", "version: v1alpha1\nsteps:\n  - run: \"true\"\n    agent: hi\n", "multiple action keys"},
		{"removed key", "version: v1alpha1\nsteps:\n  - run: \"true\"\n    out: x\n", `Unrecognized key: "out"`},
		{"shell template", "version: v1alpha1\nsteps:\n  - run: 'echo {{inputs.base}}'\n", "templates are not allowed in shell command text"},
		{"argv shell", "version: v1alpha1\nsteps:\n  - run: [git, status]\n    shell: bash\n", "argv form does not use a shell"},
		{"agent mutex", "version: v1alpha1\nsteps:\n  - agent: hi\n    using: a\n    target: b\n", "mutually exclusive"},
		{"target pane", "version: v1alpha1\nsteps:\n  - agent: hi\n    target: x\n    pane: {open: tab}\n", "target: rejects pane"},
		{"tab target", "version: v1alpha1\nsteps:\n  - agent: hi\n    pane: {open: tab, target: p}\n", "pane.target applies only to beside/below"},
		{"tab size", "version: v1alpha1\nsteps:\n  - agent: hi\n    pane: {open: tab, size: 40}\n", "pane.size applies only to beside/below"},
		{"split workspace", "version: v1alpha1\nsteps:\n  - agent: hi\n    pane: {open: beside, workspace: main}\n", "pane.workspace applies only to tab"},
		{"split name", "version: v1alpha1\nsteps:\n  - agent: hi\n    pane: {open: beside, name: logs}\n", "pane.name applies only to tab"},
		{"ready needs pane", "version: v1alpha1\nsteps:\n  - run: sleep\n    ready_when: /ok/\n", "ready_when: requires pane:"},
		{"ready needs timeout", "version: v1alpha1\nsteps:\n  - run: sleep\n    pane: {open: tab}\n    ready_when: /ok/\n", "ready_when: requires timeout"},
		{"ready invalid", "version: v1alpha1\nsteps:\n  - run: sleep\n    pane: {open: tab}\n    ready_when: //\n    timeout: 1s\n", "ready_when"},
		{"background ready", "version: v1alpha1\nsteps:\n  - run: sleep\n    pane: {open: tab}\n    background: true\n    ready_when: /ok/\n    timeout: 1s\n", "background: and ready_when:"},
		{"background timeout", "version: v1alpha1\nsteps:\n  - run: sleep\n    pane: {open: tab}\n    background: true\n    timeout: 1s\n", "background: rejects timeout"},
		{"placed needs lifecycle", "version: v1alpha1\nsteps:\n  - run: sleep\n    pane: {open: tab}\n", "placed run requires background: or ready_when:"},
		{"background needs pane", "version: v1alpha1\nsteps:\n  - run: sleep\n    background: true\n", "background: requires pane:"},
		{"run rejects pane close", "version: v1alpha1\nsteps:\n  - run: sleep\n    pane: {open: tab, close: always}\n    background: true\n", "run: rejects pane.close"},
		{"success code duplicate", "version: v1alpha1\nsteps:\n  - run: sleep\n    success_codes: [0, 0]\n", "success_codes: duplicate exit code 0"},
		{"success codes placed", "version: v1alpha1\nsteps:\n  - run: sleep\n    pane: {open: tab}\n    background: true\n    success_codes: [0, 1]\n", "success_codes: applies only to blocking local run:"},
		{"expect on background", "version: v1alpha1\nsteps:\n  - agent: hi\n    background: true\n    pane: {open: tab}\n    expect: {one_of: [DONE]}\n", "background: rejects expect"},
		{"expect duplicate", "version: v1alpha1\nsteps:\n  - agent: hi\n    expect: {one_of: [APPROVE, APPROVE]}\n", "duplicate verdict token 'APPROVE'"},
		{"expect subset", "version: v1alpha1\nsteps:\n  - agent: hi\n    expect: {one_of: [APPROVE], require: [REJECT]}\n", "'REJECT' is not in one_of"},
		{"expect empty", "version: v1alpha1\nsteps:\n  - agent: hi\n    expect: {one_of: []}\n", "expected array to have >=1 items"},
		{"dynamic choice bad root", "version: v1alpha1\ninputs:\n  branch:\n    type: choice\n    options: {run: [git, '{{context.cwd}}']}\nsteps:\n  - run: \"true\"\n", "dynamic choice argv templates may only reference earlier inputs"},
		{"ready retry", "version: v1alpha1\nsteps:\n  - run: sleep\n    pane: {open: tab}\n    ready_when: /ok/\n    timeout: 1s\n    retry: {attempts: 2}\n", "ready_when: rejects retry"},
		{"agent retry unknown", "version: v1alpha1\nsteps:\n  - agent: hi\n    retry: {attempts: 2}\n", `Unrecognized key: "retry"`},
		{"on failure background", "version: v1alpha1\non_failure:\n  run: \"true\"\n  background: true\n  pane: {open: tab}\nsteps:\n  - run: \"true\"\n", "on_failure rejects background"},
		{"on failure retry", "version: v1alpha1\non_failure:\n  run: \"true\"\n  retry: {attempts: 2}\nsteps:\n  - run: \"true\"\n", "on_failure rejects retry"},
		{"on failure expect", "version: v1alpha1\non_failure:\n  agent: hi\n  expect: {one_of: [OK, NO]}\nsteps:\n  - run: \"true\"\n", `Unrecognized key: "expect"`},
		{"unknown template root", "version: v1alpha1\nsteps:\n  - agent: 'see {{foo.bar}}'\n", "invalid template '{{foo.bar}}'"},
		{"scratch template root", "version: v1alpha1\nsteps:\n  - agent: 'see {{scratch.x}}'\n", "invalid template '{{scratch.x}}'"},
		{"near miss root", "version: v1alpha1\nsteps:\n  - run: [echo, '{{input.base}}']\n", "invalid template '{{input.base}}'"},
		{"bare root", "version: v1alpha1\nsteps:\n  - agent: '{{steps}}'\n", "invalid template '{{steps}}'"},
		{"unclosed template", "version: v1alpha1\nsteps:\n  - agent: 'see {{inputs.base'\n", "invalid template '{{inputs.base'"},
		{"bad when template", "version: v1alpha1\nsteps:\n  - run: \"true\"\n    when: '{{stepz.x}}'\n", "invalid template '{{stepz.x}}'"},
		{"arbitrary when", "version: v1alpha1\nsteps:\n  - run: \"true\"\n    when: test -n x\n", "when: must be a whole-value template"},
		{"denied herdr", "version: v1alpha1\nsteps:\n  - herdr: server.stop\n", "server.stop"},
		{"unknown herdr", "version: v1alpha1\nsteps:\n  - herdr: pane.splitt\n", "unknown herdr method"},
		{"focus policy", "version: v1alpha1\nsteps:\n  - herdr: pane.split\n    params: {direction: right}\n", "target_pane_id is required"},
		{"returns embedded", "version: v1alpha1\nreturns: 'x {{steps.a.stdout}}'\nsteps:\n  - id: a\n    run: \"true\"\n", "must be a whole-value template"},
		{"choice needs options", "version: v1alpha1\ninputs:\n  pick: {type: choice}\nsteps:\n  - run: \"true\"\n", "choice input requires options"},
		{"text rejects options", "version: v1alpha1\ninputs:\n  note: {type: text, options: [a]}\nsteps:\n  - run: \"true\"\n", "text input rejects options"},
		{"allow custom type", "version: v1alpha1\ninputs:\n  note: {type: text, allow_custom: false}\nsteps:\n  - run: \"true\"\n", "allow_custom is only valid"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			mustReject(t, test.body, test.want)
		})
	}
}

func TestParseRawSuccesses(t *testing.T) {
	t.Run("minimal and metadata", func(t *testing.T) {
		raw := mustParse(t, "version: v1alpha1\ntitle: Ship\ndescription: push\nhidden: true\nsteps:\n  - run: bun test\n")
		if raw.Version != Format || raw.Title != "Ship" || raw.Description != "push" || !raw.Hidden || len(raw.Steps) != 1 {
			t.Fatalf("unexpected workflow: %#v", raw)
		}
		run := raw.Steps[0].Action.(RunAction)
		if run.Payload.Command != "bun test" || run.Payload.Shell != "" {
			t.Fatalf("unexpected shell payload: %#v", run.Payload)
		}
	})

	t.Run("four actions", func(t *testing.T) {
		raw := mustParse(t, "version: v1alpha1\nsteps:\n  - agent: review this\n    using: deep-review\n  - run: [git, status]\n  - herdr: notification.show\n    params: {title: done}\n  - workflow: gate\n    inputs: {suite: unit}\n")
		if got := []string{ActionKind(raw.Steps[0].Action), ActionKind(raw.Steps[1].Action), ActionKind(raw.Steps[2].Action), ActionKind(raw.Steps[3].Action)}; strings.Join(got, ",") != "agent,run,herdr,workflow" {
			t.Fatalf("got actions %v", got)
		}
	})

	t.Run("argv and pane", func(t *testing.T) {
		raw := mustParse(t, "version: v1alpha1\ninputs:\n  branch: text\nsteps:\n  - id: boot\n    run: [echo, '{{inputs.branch}}']\n    pane:\n      open: beside\n      target: '{{context.pane}}'\n      size: 40\n    ready_when: /ready/\n    timeout: 30s\n")
		run := raw.Steps[0].Action.(RunAction)
		if !run.Payload.IsArgv() || len(run.Payload.Argv) != 2 || run.Pane == nil || run.Pane.Size == nil || *run.Pane.Size != 40 || run.ReadyWhen != "ready" || run.Timeout != 30*time.Second {
			t.Fatalf("unexpected placed argv action: %#v", run)
		}
	})

	t.Run("when and retry", func(t *testing.T) {
		raw := mustParse(t, "version: v1alpha1\nsteps:\n  - run: \"true\"\n    when: ['{{inputs.mode}} == \"push\"', '{{context.platform}} != \"windows\"']\n    retry: {attempts: 3, delay: 250ms}\n")
		run := raw.Steps[0].Action.(RunAction)
		if len(raw.Steps[0].When) != 2 || raw.Steps[0].When[0].Kind != WhenEqual || raw.Steps[0].When[0].Value != "push" || run.Retry == nil || run.Retry.Delay != 250*time.Millisecond {
			t.Fatalf("unexpected when/retry: %#v %#v", raw.Steps[0].When, run.Retry)
		}
	})

	t.Run("inputs and returns", func(t *testing.T) {
		raw := mustParse(t, "version: v1alpha1\ninputs:\n  note: text\n  role: profile\n  branch: [main, develop]\n  pick:\n    type: choice\n    options: [a, b]\n    default: a\nreturns:\n  findings: '{{steps.review}}'\nsteps:\n  - id: review\n    agent: review\n")
		static, ok := raw.Inputs[2].Value.(RawInputStatic)
		if len(raw.Inputs) != 4 || raw.Inputs[0].Name != "note" || !ok || static[1] != "develop" || raw.Returns == nil || raw.Returns.Fields[0].Name != "findings" {
			t.Fatalf("unexpected raw inputs/returns: %#v %#v", raw.Inputs, raw.Returns)
		}
	})

	t.Run("expect", func(t *testing.T) {
		raw := mustParse(t, "version: v1alpha1\nsteps:\n  - agent: review\n    expect: {one_of: [APPROVE, REJECT], require: [APPROVE]}\n")
		agent := raw.Steps[0].Action.(AgentAction)
		if agent.Expect == nil || strings.Join(agent.Expect.OneOf, ",") != "APPROVE,REJECT" || strings.Join(agent.Expect.Require, ",") != "APPROVE" {
			t.Fatalf("unexpected expect: %#v", agent.Expect)
		}
	})

	t.Run("success codes and herdr retry", func(t *testing.T) {
		raw := mustParse(t, "version: v1alpha1\nsteps:\n  - run: sleep\n    success_codes: [0, 1]\n  - herdr: notification.show\n    params: {title: done}\n    retry: {attempts: 2, delay: 1s}\n")
		run := raw.Steps[0].Action.(RunAction)
		herdr := raw.Steps[1].Action.(HerdrAction)
		if len(run.SuccessCodes) != 2 || herdr.Retry == nil || herdr.Retry.Delay != time.Second {
			t.Fatalf("unexpected success codes/retry: %#v %#v", run, herdr)
		}
	})
}

func TestParseDuration(t *testing.T) {
	for _, test := range []struct {
		text string
		want time.Duration
	}{
		{"500ms", 500 * time.Millisecond},
		{"2s", 2 * time.Second},
		{"3m", 3 * time.Minute},
		{"1h", time.Hour},
	} {
		got, err := ParseDuration(test.text)
		if err != nil || got != test.want {
			t.Errorf("ParseDuration(%q) = %v, %v, want %v", test.text, got, err, test.want)
		}
	}
	for _, text := range []string{"0s", "5"} {
		if _, err := ParseDuration(text); err == nil {
			t.Errorf("ParseDuration(%q) accepted", text)
		}
	}
}

func TestTemplates(t *testing.T) {
	if got, ok := ParseTemplatePath("steps.assess.response"); !ok || got.Root != "steps" || strings.Join(got.Segments, ".") != "assess.response" {
		t.Fatalf("bad path: %#v, %v", got, ok)
	}
	for _, text := range []string{"prompt", "inputs", "{{prompt}}"} {
		if _, ok := ParseTemplatePath(text); ok {
			t.Errorf("ParseTemplatePath(%q) accepted", text)
		}
	}
	if !IsWholeValueTemplate("{{steps.a}}") || IsWholeValueTemplate("x {{steps.a}}") {
		t.Fatal("whole-value template detection failed")
	}
	for _, test := range []struct {
		value string
		want  string
	}{
		{"hi", "hi"},
		{"true", "true"},
		{"false", "false"},
		{"1.5", "1.5"},
		{"null", ""},
	} {
		var value any
		switch test.value {
		case "true":
			value = true
		case "false":
			value = false
		case "1.5":
			value = 1.5
		case "null":
			value = nil
		default:
			value = test.value
		}
		if got := RenderScalar(value); got != test.want {
			t.Errorf("RenderScalar(%#v) = %q, want %q", value, got, test.want)
		}
	}
	if got := RenderScalar(map[string]any{"a": 1}); got != `{"a":1}` {
		t.Errorf("object render = %q", got)
	}
	if got := RenderScalar([]any{1, 2}); got != "[1,2]" {
		t.Errorf("array render = %q", got)
	}

	ns := TemplateNamespace{
		Inputs:  map[string]any{"base": "main", "n": 3},
		Steps:   map[string]any{"review": map[string]any{"response": "ok", "pane_id": "p1"}},
		Context: map[string]any{"platform": "macos"},
	}
	if got := SubstituteText("branch {{inputs.base}}", ns); got != "branch main" {
		t.Errorf("text substitution = %q", got)
	}
	if got := SubstituteValue("{{steps.review}}", ns); got == nil || RenderScalar(got) != `{"pane_id":"p1","response":"ok"}` {
		t.Errorf("structured substitution = %#v", got)
	}
	if got := SubstituteValue("got {{steps.review.response}}", ns); got != "got ok" {
		t.Errorf("embedded substitution = %#v", got)
	}
	params := SubstituteParams(map[string]any{"pane_id": "{{steps.review.pane_id}}", "nested": map[string]any{"count": "{{inputs.n}}"}, "flag": true}, ns)
	if params["pane_id"] != "p1" || params["nested"].(map[string]any)["count"] != 3 || params["flag"] != true {
		t.Fatalf("params substitution = %#v", params)
	}
	refs := TextTemplates("{{inputs.a}} and {{steps.b.c}}")
	if len(refs) != 2 || refs[0].Root != "inputs" || refs[1].Root != "steps" {
		t.Fatalf("refs = %#v", refs)
	}
}

func TestWhenEvaluation(t *testing.T) {
	ns := TemplateNamespace{Inputs: map[string]any{"empty": "", "yes": "yes", "zero": 0}, Context: map[string]any{"platform": "macos"}}
	truthy := WhenSpec{Kind: WhenTruthy, Path: "inputs.yes"}
	if !EvaluateWhen([]WhenSpec{truthy}, ns) || EvaluateWhen([]WhenSpec{{Kind: WhenTruthy, Path: "inputs.empty"}}, ns) {
		t.Fatal("truthiness evaluation failed")
	}
	if !EvaluateWhen([]WhenSpec{{Kind: WhenEqual, Path: "context.platform", Value: "macos"}}, ns) {
		t.Fatal("equality evaluation failed")
	}
}
