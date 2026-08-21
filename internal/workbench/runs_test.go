package workbench

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/history"
)

func histRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	t.Setenv("HERDR_PLUGIN_CONFIG_DIR", t.TempDir())
	if err := os.MkdirAll(filepath.Join(root, ".hwf", "workflows"), 0o755); err != nil {
		t.Fatal(err)
	}
	demo := "version: v1alpha1\nsteps:\n  - run: [printf, hi]\n"
	if err := os.WriteFile(filepath.Join(root, ".hwf", "workflows", "demo.yaml"), []byte(demo), 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func withHistState(t *testing.T) (cleanup func()) {
	t.Helper()
	state := t.TempDir()
	prev := os.Getenv("HERDR_PLUGIN_STATE_DIR")
	t.Setenv("HERDR_PLUGIN_STATE_DIR", state)
	return func() {
		if prev == "" {
			_ = os.Unsetenv("HERDR_PLUGIN_STATE_DIR")
		} else {
			t.Setenv("HERDR_PLUGIN_STATE_DIR", prev)
		}
	}
}

func histGET(t *testing.T, url, token string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("X-Hwf-Token", token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestRunHistoryUnauthorizedForbidden(t *testing.T) {
	// Ports test/workbench/web-server.test.ts "unauthorized access is forbidden".
	defer withHistState(t)()
	s := startTestServer(t, histRepo(t))
	res := histGET(t, originOf(s.port)+"/api/runs", "")
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", res.StatusCode)
	}
}

func TestRunHistoryJSONUsesNoStore(t *testing.T) {
	// Ports test/workbench/web-server.test.ts "authenticated JSON responses use no-store by default".
	defer withHistState(t)()
	s := startTestServer(t, histRepo(t))
	token := s.Token
	base := originOf(s.port)

	runs := histGET(t, base+"/api/runs", token)
	defer func() { _ = runs.Body.Close() }()
	if runs.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("runs cache-control = %q", runs.Header.Get("Cache-Control"))
	}

	favicon, err := http.Get(base + "/favicon.svg")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = favicon.Body.Close() }()
	if cc := favicon.Header.Get("Cache-Control"); !strings.Contains(cc, "public") {
		t.Fatalf("favicon cache-control = %q", cc)
	}
}

func TestRunHistoryListDetailExcludePrivateOutput(t *testing.T) {
	// Ports test/workbench/web-server.test.ts "list and detail use no-store and exclude private output".
	defer withHistState(t)()
	root := histRepo(t)
	writer := history.NewWriter(nil)
	exitCode := 2
	claim := writer.Claim(history.ClaimMeta{
		Workflow: "demo", Source: "repo", CheckoutRoot: root,
	})
	if !claim.OK || claim.State != "claimed" {
		t.Fatalf("claim = %+v", claim)
	}
	writer.RecordStep(history.StepRecord{
		StepIdentity: history.StepIdentity{
			Phase: "main", Workflow: "demo", WorkflowPath: []string{"demo"},
			Ordinal: 1, Total: 1, Action: "run", Label: "boom",
		},
		FinishedAt:  time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Outcome:     "failed",
		Failure:     &history.FailureFact{Action: "run", ExitCode: &exitCode},
		Explanation: "secret-stdout-body",
	})
	writer.Finalize("failed", history.FinalizeOpts{})
	runID := writer.ID()
	writer.Dispose()

	s := startTestServer(t, root)
	listRes := histGET(t, originOf(s.port)+"/api/runs", s.Token)
	defer func() { _ = listRes.Body.Close() }()
	if listRes.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("list cache-control = %q", listRes.Header.Get("Cache-Control"))
	}
	var listBody struct {
		OK   bool              `json:"ok"`
		Runs []history.Summary `json:"runs"`
	}
	if err := json.NewDecoder(listRes.Body).Decode(&listBody); err != nil {
		t.Fatal(err)
	}
	if !listBody.OK || len(listBody.Runs) == 0 {
		t.Fatalf("list = %+v", listBody)
	}
	raw, _ := json.Marshal(listBody)
	if strings.Contains(string(raw), "secret-stdout-body") {
		t.Fatal("list leaked private output")
	}
	if listBody.Runs[0].Failure == nil || listBody.Runs[0].Failure.ExitCode == nil || *listBody.Runs[0].Failure.ExitCode != 2 {
		t.Fatalf("failure fact = %+v", listBody.Runs[0].Failure)
	}

	detailRes := histGET(t, originOf(s.port)+"/api/run?id="+runID, s.Token)
	defer func() { _ = detailRes.Body.Close() }()
	if detailRes.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("detail cache-control = %q", detailRes.Header.Get("Cache-Control"))
	}
	var detailBody struct {
		OK     bool `json:"ok"`
		Detail struct {
			FailureExplanation string `json:"failure_explanation"`
			OpenWorkflow       *struct {
				Name string `json:"name"`
			} `json:"open_workflow"`
		} `json:"detail"`
	}
	if err := json.NewDecoder(detailRes.Body).Decode(&detailBody); err != nil {
		t.Fatal(err)
	}
	if detailBody.Detail.FailureExplanation != "secret-stdout-body" {
		t.Fatalf("failure_explanation = %q", detailBody.Detail.FailureExplanation)
	}
	if detailBody.Detail.OpenWorkflow == nil || detailBody.Detail.OpenWorkflow.Name != "demo" {
		t.Fatalf("open_workflow = %+v", detailBody.Detail.OpenWorkflow)
	}

	pageRes, err := http.Get(s.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = pageRes.Body.Close() }()
	if pageRes.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("page cache-control = %q", pageRes.Header.Get("Cache-Control"))
	}
}

func TestRunHistoryMalformedUUIDAndForeignDeepLinks(t *testing.T) {
	// Ports test/workbench/web-server.test.ts "malformed UUID and foreign deep links".
	defer withHistState(t)()
	root := histRepo(t)
	foreign := t.TempDir()
	writer := history.NewWriter(nil)
	claim := writer.Claim(history.ClaimMeta{
		Workflow: "other", Source: "global", CheckoutRoot: foreign,
	})
	if !claim.OK {
		t.Fatalf("claim = %+v", claim)
	}
	writer.Finalize("succeeded", history.FinalizeOpts{})
	foreignID := writer.ID()
	writer.Dispose()

	s := startTestServer(t, root)
	bad := histGET(t, originOf(s.port)+"/api/run?id=550e8400", s.Token)
	defer func() { _ = bad.Body.Close() }()
	if bad.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad status = %d", bad.StatusCode)
	}
	var badBody struct {
		Detail struct {
			Kind string `json:"kind"`
		} `json:"detail"`
	}
	if err := json.NewDecoder(bad.Body).Decode(&badBody); err != nil {
		t.Fatal(err)
	}
	if badBody.Detail.Kind != "invalid" {
		t.Fatalf("kind = %q", badBody.Detail.Kind)
	}

	foreignRes := histGET(t, originOf(s.port)+"/api/run?id="+foreignID, s.Token)
	defer func() { _ = foreignRes.Body.Close() }()
	var foreignBody struct {
		OK     bool `json:"ok"`
		Detail struct {
			CheckoutRoot string          `json:"checkout_root"`
			OpenWorkflow json.RawMessage `json:"open_workflow"`
		} `json:"detail"`
	}
	if err := json.NewDecoder(foreignRes.Body).Decode(&foreignBody); err != nil {
		t.Fatal(err)
	}
	if !foreignBody.OK {
		t.Fatal("foreign detail not ok")
	}
	canonicalForeign, err := filepath.EvalSymlinks(foreign)
	if err != nil {
		t.Fatal(err)
	}
	if foreignBody.Detail.CheckoutRoot != canonicalForeign {
		t.Fatalf("checkout_root = %q, want %q", foreignBody.Detail.CheckoutRoot, canonicalForeign)
	}
	if string(foreignBody.Detail.OpenWorkflow) != "null" && len(foreignBody.Detail.OpenWorkflow) > 0 {
		t.Fatalf("open_workflow = %s", foreignBody.Detail.OpenWorkflow)
	}
}

func TestRunHistoryUnsafeStorageUnavailable(t *testing.T) {
	// Ports test/workbench/web-server.test.ts "unsafe storage returns unavailable".
	if runtime.GOOS == "windows" {
		t.Skip("chmod semantics differ on Windows")
	}
	defer withHistState(t)()
	root := histRepo(t)
	state := os.Getenv("HERDR_PLUGIN_STATE_DIR")
	if err := os.MkdirAll(state, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(state, "marker"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(state, 0o755); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	res := histGET(t, originOf(s.port)+"/api/runs", s.Token)
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", res.StatusCode)
	}
}

func TestRunHistoryPriorSharedRunsJSONLDoesNotAppearInAll(t *testing.T) {
	// Ports test/workbench/web-server.test.ts "prior shared runs.jsonl does not appear in All".
	defer withHistState(t)()
	root := histRepo(t)
	stateDir, err := config.PluginStateDir(nil)
	if err != nil {
		t.Fatal(err)
	}
	priorPath := filepath.Join(stateDir, "runs.jsonl")
	body := `{"ts":"2020-01-01T00:00:00.000Z","run":"abcd1234","workflow":"old-log","ok":true}` + "\n"
	if err := os.WriteFile(priorPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	res := histGET(t, originOf(s.port)+"/api/runs?location=all", s.Token)
	defer func() { _ = res.Body.Close() }()
	var allBody struct {
		Runs []struct {
			Workflow string `json:"workflow"`
		} `json:"runs"`
	}
	if err := json.NewDecoder(res.Body).Decode(&allBody); err != nil {
		t.Fatal(err)
	}
	for _, run := range allBody.Runs {
		if run.Workflow == "old-log" {
			t.Fatal("legacy runs.jsonl entry appeared in All")
		}
	}
	got, err := os.ReadFile(priorPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != body {
		t.Fatal("prior runs.jsonl was modified")
	}
}

func TestRouteParsingRequiresCompleteUUID(t *testing.T) {
	// Ports test/workbench/web-server.test.ts "route parsing requires complete UUID".
	id := history.AllocateRunID()
	parsed := ParseWebRoute(RunWorkbenchRoute(id))
	if parsed == nil || parsed.Kind != "run" || parsed.ID != id || parsed.Hash != "run="+id {
		t.Fatalf("parsed = %+v", parsed)
	}
	if ParseWebRoute("run=550e8400") != nil {
		t.Fatal("truncated UUID must not parse")
	}
	upper := ParseWebRoute("run=" + strings.ToUpper(id))
	if upper == nil || upper.Kind != "run" || upper.ID != id {
		t.Fatalf("upper = %+v", upper)
	}
}

func TestRunHistoryDeletedRootInspectableWithoutOpenAction(t *testing.T) {
	// Ports test/workbench/web-server.test.ts "deleted root remains inspectable without open action".
	defer withHistState(t)()
	root := histRepo(t)
	gone := t.TempDir()
	canonicalGone, err := filepath.EvalSymlinks(gone)
	if err != nil {
		t.Fatal(err)
	}
	writer := history.NewWriter(nil)
	claim := writer.Claim(history.ClaimMeta{
		Workflow: "demo", Source: "repo", CheckoutRoot: gone,
	})
	if !claim.OK {
		t.Fatalf("claim = %+v", claim)
	}
	writer.Finalize("succeeded", history.FinalizeOpts{})
	runID := writer.ID()
	writer.Dispose()
	if err := os.RemoveAll(gone); err != nil {
		t.Fatal(err)
	}

	s := startTestServer(t, root)
	res := histGET(t, originOf(s.port)+"/api/run?id="+runID, s.Token)
	defer func() { _ = res.Body.Close() }()
	var body struct {
		OK     bool `json:"ok"`
		Detail struct {
			CheckoutRoot string          `json:"checkout_root"`
			OpenWorkflow json.RawMessage `json:"open_workflow"`
		} `json:"detail"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !body.OK {
		t.Fatal("detail not ok")
	}
	if body.Detail.CheckoutRoot != canonicalGone {
		t.Fatalf("checkout_root = %q, want %q", body.Detail.CheckoutRoot, canonicalGone)
	}
	if string(body.Detail.OpenWorkflow) != "null" && len(body.Detail.OpenWorkflow) > 0 {
		t.Fatalf("open_workflow = %s", body.Detail.OpenWorkflow)
	}
}

func TestRunHistoryPageWithoutTokenForbidden(t *testing.T) {
	s := startTestServer(t, testRepo(t))
	res, err := http.Get(originOf(s.port) + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	_, _ = io.Copy(io.Discard, res.Body)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", res.StatusCode)
	}
}
