package workbench

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/config"
)

const v1 = "version: v1alpha1\n"

func wbGET(t *testing.T, s *Server, path string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, originOf(s.port)+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Hwf-Token", s.Token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func wbPOST(t *testing.T, s *Server, path string, body any) *http.Response {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, originOf(s.port)+path, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Hwf-Token", s.Token)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func decodeResponse(t *testing.T, res *http.Response, dst any) {
	t.Helper()
	defer func() { _ = res.Body.Close() }()
	if err := json.NewDecoder(res.Body).Decode(dst); err != nil {
		t.Fatal(err)
	}
}

func TestValidTokenServesState(t *testing.T) {
	root := testRepo(t)
	s := startTestServer(t, root)
	res := wbGET(t, s, "/api/state")
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var data struct {
		Profiles          []string `json:"profiles"`
		CanonicalRepoRoot string   `json:"canonicalRepoRoot"`
		WorkflowSchemaURL string   `json:"workflowSchemaUrl"`
	}
	decodeResponse(t, res, &data)
	if !slices.Contains(data.Profiles, "claude") {
		t.Fatalf("profiles = %v, want claude", data.Profiles)
	}
	if data.CanonicalRepoRoot != root {
		t.Fatalf("canonicalRepoRoot = %q, want %q", data.CanonicalRepoRoot, root)
	}
	wantURL := config.WorkflowSchemaURL()
	if data.WorkflowSchemaURL != wantURL {
		t.Fatalf("workflowSchemaUrl = %q, want %q", data.WorkflowSchemaURL, wantURL)
	}
	if strings.Contains(data.WorkflowSchemaURL, "/main/") {
		t.Fatalf("workflowSchemaUrl must not contain /main/: %q", data.WorkflowSchemaURL)
	}
}

func TestParseThenFormatRoundTrip(t *testing.T) {
	root := testRepo(t)
	s := startTestServer(t, root)
	yaml := v1 + "steps:\n  - run: echo hi\n  - agent: go\n    using: claude\n"
	var parsed struct {
		OK  bool           `json:"ok"`
		Doc map[string]any `json:"doc"`
	}
	decodeResponse(t, wbPOST(t, s, "/api/parse", map[string]any{"text": yaml}), &parsed)
	if !parsed.OK {
		t.Fatal("parse failed")
	}
	var formatted struct {
		OK   bool   `json:"ok"`
		Text string `json:"text"`
	}
	decodeResponse(t, wbPOST(t, s, "/api/format", map[string]any{"doc": parsed.Doc}), &formatted)
	if !formatted.OK {
		t.Fatal("format failed")
	}
	if !strings.Contains(formatted.Text, "run: echo hi") {
		t.Fatalf("formatted text missing run step: %q", formatted.Text)
	}
	if !strings.Contains(formatted.Text, "\n\n  - agent:") {
		t.Fatalf("formatted text missing blank line before agent step: %q", formatted.Text)
	}
	if !strings.Contains(formatted.Text, "using: claude") {
		t.Fatalf("formatted text missing using: %q", formatted.Text)
	}
}

func TestFormatManagedAgentModes(t *testing.T) {
	root := testRepo(t)
	s := startTestServer(t, root)
	doc := map[string]any{
		"version": "v1alpha1",
		"title":   "Review",
		"steps": []any{
			map[string]any{
				"id":    "ask",
				"agent": "summarize {{context.selection}}",
				"using": "claude",
				"pane":  map[string]any{"open": "beside", "size": 40, "close": "success"},
			},
			map[string]any{
				"id":     "follow",
				"agent":  "continue",
				"target": "{{steps.ask.agent.name}}",
			},
			map[string]any{
				"herdr": "notification.show",
				"params": map[string]any{
					"title": "done",
					"body":  "{{steps.ask.response}} pane={{steps.ask.pane_id}}",
				},
			},
		},
	}
	var formatted struct {
		OK   bool   `json:"ok"`
		Text string `json:"text"`
	}
	decodeResponse(t, wbPOST(t, s, "/api/format", map[string]any{"doc": doc}), &formatted)
	if !formatted.OK {
		t.Fatal("format failed")
	}
	text := formatted.Text
	for _, want := range []string{"title: Review", "using: claude", "target:", "herdr: notification.show", "steps.ask.response"} {
		if !strings.Contains(text, want) {
			t.Fatalf("formatted text missing %q: %q", want, text)
		}
	}
	if !regexp.MustCompile(`"open"\s*:\s*"beside"|open: beside`).MatchString(text) {
		t.Fatalf("formatted text missing pane open beside: %q", text)
	}
}

func TestFormatRejectsDocWithNoSteps(t *testing.T) {
	root := testRepo(t)
	s := startTestServer(t, root)
	var data struct {
		OK bool `json:"ok"`
	}
	decodeResponse(t, wbPOST(t, s, "/api/format", map[string]any{
		"doc": map[string]any{"version": "v1alpha1", "steps": []any{}},
	}), &data)
	if data.OK {
		t.Fatal("expected format to fail for empty steps")
	}
}

func TestFormatOnFailureHerdr(t *testing.T) {
	root := testRepo(t)
	s := startTestServer(t, root)
	doc := map[string]any{
		"version": "v1alpha1",
		"steps":   []any{map[string]any{"run": "echo hi"}},
		"on_failure": map[string]any{
			"herdr": "notification.show",
			"params": map[string]any{
				"title": "handoff failed",
				"body":  "{{context.error.message}}",
				"sound": "request",
			},
		},
	}
	var formatted struct {
		OK   bool   `json:"ok"`
		Text string `json:"text"`
	}
	decodeResponse(t, wbPOST(t, s, "/api/format", map[string]any{"doc": doc}), &formatted)
	if !formatted.OK {
		t.Fatal("format failed")
	}
	if !regexp.MustCompile(`\non_failure:\n {2}herdr:`).MatchString(formatted.Text) {
		t.Fatalf("on_failure herdr layout missing: %q", formatted.Text)
	}
	if !regexp.MustCompile(`\n {2}params:`).MatchString(formatted.Text) {
		t.Fatalf("on_failure params layout missing: %q", formatted.Text)
	}
	if regexp.MustCompile(`\non_failure:\n {2}- `).MatchString(formatted.Text) {
		t.Fatalf("on_failure must not be a list: %q", formatted.Text)
	}
	var reparsed struct {
		OK  bool `json:"ok"`
		Doc struct {
			OnFailure struct {
				Herdr  string            `json:"herdr"`
				Params map[string]string `json:"params"`
			} `json:"on_failure"`
		} `json:"doc"`
	}
	decodeResponse(t, wbPOST(t, s, "/api/parse", map[string]any{"text": formatted.Text}), &reparsed)
	if !reparsed.OK {
		t.Fatal("reparse failed")
	}
	if reparsed.Doc.OnFailure.Herdr != "notification.show" {
		t.Fatalf("on_failure.herdr = %q", reparsed.Doc.OnFailure.Herdr)
	}
	for key, want := range map[string]string{
		"title": "handoff failed",
		"body":  "{{context.error.message}}",
		"sound": "request",
	} {
		if reparsed.Doc.OnFailure.Params[key] != want {
			t.Fatalf("on_failure.params[%q] = %q, want %q", key, reparsed.Doc.OnFailure.Params[key], want)
		}
	}
}

func TestSchemaEndpoint(t *testing.T) {
	root := testRepo(t)
	s := startTestServer(t, root)
	res := wbGET(t, s, "/api/schema")
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var schema struct {
		Properties struct {
			Steps struct {
				Items struct {
					Properties map[string]json.RawMessage `json:"properties"`
				} `json:"items"`
			} `json:"steps"`
		} `json:"properties"`
	}
	decodeResponse(t, res, &schema)
	step := schema.Properties.Steps.Items.Properties
	if _, ok := step["success_codes"]; !ok {
		t.Fatal("schema missing success_codes")
	}
	var shell struct {
		Enum []string `json:"enum"`
	}
	if err := json.Unmarshal(step["shell"], &shell); err != nil {
		t.Fatal(err)
	}
	wantShell := []string{"sh", "bash", "zsh", "pwsh", "powershell", "cmd"}
	if !slices.Equal(shell.Enum, wantShell) {
		t.Fatalf("shell enum = %v, want %v", shell.Enum, wantShell)
	}
	var pane struct {
		Properties map[string]struct {
			Type    string `json:"type"`
			Minimum int    `json:"minimum"`
			Maximum int    `json:"maximum"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(step["pane"], &pane); err != nil {
		t.Fatal(err)
	}
	size := pane.Properties["size"]
	if size.Type != "integer" || size.Minimum != 1 || size.Maximum != 99 {
		t.Fatalf("pane.size = %+v", size)
	}
	var retry struct {
		Properties map[string]struct {
			Type    string `json:"type"`
			Minimum int    `json:"minimum"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(step["retry"], &retry); err != nil {
		t.Fatal(err)
	}
	attempts := retry.Properties["attempts"]
	if attempts.Type != "integer" || attempts.Minimum != 2 {
		t.Fatalf("retry.attempts = %+v", attempts)
	}
}

func TestMethodsEndpoint(t *testing.T) {
	root := testRepo(t)
	s := startTestServer(t, root)
	res := wbGET(t, s, "/api/methods")
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var data struct {
		Methods []struct {
			Method  string `json:"method"`
			Allowed bool   `json:"allowed"`
			Reason  string `json:"reason"`
			Params  struct {
				Required   []string `json:"required"`
				Properties map[string]struct {
					Kinds []string `json:"kinds"`
				} `json:"properties"`
			} `json:"params"`
		} `json:"methods"`
	}
	decodeResponse(t, res, &data)
	var show, denied *struct {
		Method  string `json:"method"`
		Allowed bool   `json:"allowed"`
		Reason  string `json:"reason"`
		Params  struct {
			Required   []string `json:"required"`
			Properties map[string]struct {
				Kinds []string `json:"kinds"`
			} `json:"properties"`
		} `json:"params"`
	}
	for i := range data.Methods {
		switch data.Methods[i].Method {
		case "notification.show":
			show = &data.Methods[i]
		case "server.stop":
			denied = &data.Methods[i]
		}
	}
	if show == nil || !show.Allowed {
		t.Fatal("notification.show missing or not allowed")
	}
	if !slices.Equal(show.Params.Required, []string{"title"}) {
		t.Fatalf("notification.show required = %v", show.Params.Required)
	}
	if !slices.Equal(show.Params.Properties["sound"].Kinds, []string{"string"}) {
		t.Fatalf("notification.show sound kinds = %v", show.Params.Properties["sound"].Kinds)
	}
	if denied == nil || denied.Allowed {
		t.Fatal("server.stop missing or allowed")
	}
	if !strings.Contains(denied.Reason, "would stop the server running the workflow") {
		t.Fatalf("server.stop reason = %q", denied.Reason)
	}
}

func TestFormatValidationIssuePaths(t *testing.T) {
	root := testRepo(t)
	s := startTestServer(t, root)
	var data struct {
		OK     bool   `json:"ok"`
		Error  string `json:"error"`
		Issues []struct {
			Path    []any  `json:"path"`
			Message string `json:"message"`
		} `json:"issues"`
	}
	decodeResponse(t, wbPOST(t, s, "/api/format", map[string]any{
		"doc": map[string]any{
			"version": "v1alpha1",
			"steps": []any{
				map[string]any{"run": "echo hi", "pane": map[string]any{"open": "beside"}, "background": true, "retry": map[string]any{"attempts": 3}},
				map[string]any{"run": "echo hi", "pane": map[string]any{"size": 200}},
				map[string]any{"run": "echo hi", "pane": map[string]any{"open": "tab", "size": 40}},
			},
		},
	}), &data)
	if data.OK {
		t.Fatal("expected format validation failure")
	}
	if !strings.Contains(data.Error, "retry") {
		t.Fatalf("error = %q, want retry mention", data.Error)
	}
	pathOf := func(want string) string {
		for _, issue := range data.Issues {
			if issuePathString(issue.Path) == want {
				return issue.Message
			}
		}
		return ""
	}
	if msg := pathOf("steps.0.retry"); msg == "" || !strings.Contains(msg, "retry") {
		t.Fatalf("steps.0.retry issue = %q", msg)
	}
	if msg := pathOf("steps.1.pane.size"); msg == "" || !strings.Contains(msg, "<=99") {
		t.Fatalf("steps.1.pane.size issue = %q", msg)
	}
	if msg := pathOf("steps.2.pane.size"); msg == "" || !strings.Contains(msg, "pane.size") {
		t.Fatalf("steps.2.pane.size issue = %q", msg)
	}
}

func TestStateProvenanceAndSensitivity(t *testing.T) {
	root := testRepo(t)
	if err := os.WriteFile(filepath.Join(root, ".hwf", "workflows", "review.yaml"), []byte(v1+`title: Review pane
description: Uses transcript
steps:
  - agent: "see {{context.transcript}}"
    using: claude
  - run: [echo, hi]
`), 0o600); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".hwf", "workflows"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".hwf", "workflows", "global-tool.yaml"), []byte(v1+`steps:
  - herdr: pane.close
    params: { pane_id: "w1:p1" }
`), 0o600); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	var data struct {
		Entries []struct {
			Name        string   `json:"name"`
			Title       string   `json:"title"`
			Description string   `json:"description"`
			Provenance  string   `json:"provenance"`
			Flags       []string `json:"flags"`
		} `json:"entries"`
	}
	decodeResponse(t, wbGET(t, s, "/api/state"), &data)
	var review, global *struct {
		Name        string   `json:"name"`
		Title       string   `json:"title"`
		Description string   `json:"description"`
		Provenance  string   `json:"provenance"`
		Flags       []string `json:"flags"`
	}
	for i := range data.Entries {
		switch data.Entries[i].Name {
		case "review":
			review = &data.Entries[i]
		case "global-tool":
			global = &data.Entries[i]
		}
	}
	if review == nil {
		t.Fatal("review entry missing")
	}
	if review.Title != "Review pane" {
		t.Fatalf("review title = %q", review.Title)
	}
	if !strings.Contains(review.Description, "transcript") {
		t.Fatalf("review description = %q", review.Description)
	}
	if review.Provenance != "repo" {
		t.Fatalf("review provenance = %q", review.Provenance)
	}
	for _, flag := range []string{"commands", "transcript"} {
		if !slices.Contains(review.Flags, flag) {
			t.Fatalf("review flags = %v, want %q", review.Flags, flag)
		}
	}
	if global == nil {
		t.Fatal("global-tool entry missing")
	}
	if global.Provenance != "global" {
		t.Fatalf("global provenance = %q", global.Provenance)
	}
	if !slices.Contains(global.Flags, "herdr:pane.close") {
		t.Fatalf("global flags = %v", global.Flags)
	}
}

func TestValidateLegacyKeys(t *testing.T) {
	root := testRepo(t)
	s := startTestServer(t, root)
	legacy := v1 + "steps:\n  - run: echo hi\n    out: x\n"
	var buffer struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	decodeResponse(t, wbPOST(t, s, "/api/validate", map[string]any{"name": "buf", "text": legacy}), &buffer)
	if buffer.OK {
		t.Fatal("expected validate failure")
	}
	if !strings.Contains(strings.ToLower(buffer.Error), "out") {
		t.Fatalf("error = %q, want out mention", buffer.Error)
	}
}

func TestValidateSensitivityFlags(t *testing.T) {
	root := testRepo(t)
	text := v1 + `steps:
  - agent: "see {{context.transcript}}"
    using: claude
  - run: [echo, hi]
  - herdr: pane.close
    params: { pane_id: "w1:p1" }
  - workflow: missing-child
`
	if err := os.WriteFile(filepath.Join(root, ".hwf", "workflows", "sens.yaml"), []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	var validated struct {
		OK    bool     `json:"ok"`
		Error string   `json:"error"`
		Flags []string `json:"flags"`
	}
	decodeResponse(t, wbPOST(t, s, "/api/validate", map[string]any{"name": "sens", "text": text}), &validated)
	if validated.OK {
		t.Fatal("expected validate failure for missing child")
	}
	if !strings.Contains(validated.Error, "missing-child") {
		t.Fatalf("error = %q", validated.Error)
	}
	for _, flag := range []string{"commands", "transcript", "herdr:pane.close", "unresolved:missing-child"} {
		if !slices.Contains(validated.Flags, flag) {
			t.Fatalf("flags = %v, want %q", validated.Flags, flag)
		}
	}
}

func issuePathString(path []any) string {
	parts := make([]string, len(path))
	for i, part := range path {
		switch v := part.(type) {
		case float64:
			parts[i] = strconv.Itoa(int(v))
		default:
			parts[i] = fmt.Sprint(v)
		}
	}
	return strings.Join(parts, ".")
}
