package engine

import (
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

var (
	managedPathRE   = regexp.MustCompile(`absolute path ([^\s,]+)`)
	spillPathRE     = regexp.MustCompile(`Read the absolute path (\S+)`)
	withinTimeoutRE = regexp.MustCompile(`within \d+s`)
)

type mockAgent struct {
	status           string
	paneID           string
	name             string
	interactiveReady bool
	launchPending    bool
}

type fakeClock struct {
	now time.Time
}

func (c *fakeClock) Now() time.Time { return c.now }

func (c *fakeClock) Sleep(d time.Duration) { c.now = c.now.Add(d) }

type agentHarness struct {
	t                       *testing.T
	calls                   []herdrCallRecord
	agents                  map[string]mockAgent
	notes                   []string
	closed                  []string
	writeManagedResponse    bool
	managedResponse         string
	clock                   *fakeClock
	responseDir             string
	interactiveReadyOnStart bool
	launchPendingOnStart    bool
	herdrCall               func(method string, params map[string]any) (map[string]any, error)
	agentStatus             func(target string) (string, error)
	agentInfo               func(target string) (map[string]any, error)
}

func newAgentHarness(t *testing.T, repoRoot string) *agentHarness {
	t.Helper()
	h := &agentHarness{
		t:                       t,
		agents:                  map[string]mockAgent{},
		writeManagedResponse:    true,
		managedResponse:         "managed answer\n",
		clock:                   &fakeClock{now: time.Unix(0, 0).UTC()},
		responseDir:             filepath.Join(repoRoot, ".hwf", "tmp"),
		interactiveReadyOnStart: true,
	}
	h.herdrCall = h.defaultHerdrCall
	h.agentStatus = h.defaultAgentStatus
	h.agentInfo = h.defaultAgentInfo
	return h
}

func (h *agentHarness) record(method string, params map[string]any) {
	h.calls = append(h.calls, herdrCallRecord{method: method, params: params})
}

func (h *agentHarness) call(method string, params map[string]any) (map[string]any, error) {
	return h.herdrCall(method, params)
}

func (h *agentHarness) status(target string) (string, error) {
	return h.agentStatus(target)
}

func (h *agentHarness) info(target string) (map[string]any, error) {
	return h.agentInfo(target)
}

func (h *agentHarness) notificationShow(title string, body *string) error {
	b := ""
	if body != nil {
		b = *body
	}
	h.notes = append(h.notes, title+"|"+b)
	return nil
}

func (h *agentHarness) paneClose(paneID string) error {
	h.closed = append(h.closed, paneID)
	return nil
}

func (h *agentHarness) lookup(target string) mockAgent {
	if a, ok := h.agents[target]; ok {
		return a
	}
	return mockAgent{
		status:           "idle",
		paneID:           target,
		name:             target,
		interactiveReady: true,
		launchPending:    false,
	}
}

func (h *agentHarness) put(a mockAgent) {
	h.agents[a.name] = a
}

func (h *agentHarness) writeResponseFile(path, content string) {
	h.t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		h.t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		h.t.Fatalf("write %s: %v", path, err)
	}
}

func responsePathFromText(text string) string {
	m := managedPathRE.FindStringSubmatch(text)
	if len(m) < 2 {
		return ""
	}
	return m[1]
}

func (h *agentHarness) defaultHerdrCall(method string, params map[string]any) (map[string]any, error) {
	h.record(method, params)
	switch method {
	case "pane.split":
		return map[string]any{
			"pane": map[string]any{
				"pane_id":      "w1:p3",
				"tab_id":       "w1:t1",
				"workspace_id": "w1",
			},
		}, nil
	case "tab.create":
		return map[string]any{
			"tab": map[string]any{
				"tab_id":       "w1:t2",
				"workspace_id": "w1",
			},
			"root_pane": map[string]any{
				"pane_id":      "w1:p2",
				"tab_id":       "w1:t2",
				"workspace_id": "w1",
			},
		}, nil
	case "pane.process_info":
		return map[string]any{
			"type": "pane_process_info",
			"process_info": map[string]any{
				"pane_id":                     params["pane_id"],
				"shell_pid":                   1001,
				"foreground_process_group_id": 1001,
				"foreground_processes": []any{
					map[string]any{
						"pid":     1001,
						"name":    "zsh",
						"argv":    []any{"zsh"},
						"argv0":   "zsh",
						"cmdline": "zsh",
						"cwd":     "/",
					},
				},
				"tty": "/dev/ttys001",
			},
		}, nil
	case "agent.start":
		name, _ := params["name"].(string)
		paneID, _ := params["pane_id"].(string)
		h.put(mockAgent{
			status:           "idle",
			paneID:           paneID,
			name:             name,
			interactiveReady: h.interactiveReadyOnStart,
			launchPending:    h.launchPendingOnStart,
		})
		return map[string]any{
			"type": "agent_started",
			"agent": map[string]any{
				"name":              name,
				"pane_id":           paneID,
				"agent_status":      "idle",
				"agent":             "claude",
				"interactive_ready": h.interactiveReadyOnStart,
				"launch_pending":    h.launchPendingOnStart,
			},
		}, nil
	case "agent.prompt":
		target, _ := params["target"].(string)
		text, _ := params["text"].(string)
		info := h.lookup(target)
		info.name = target
		path := responsePathFromText(text)
		if strings.HasSuffix(path, "-prompt.txt") {
			data, err := os.ReadFile(path)
			if err == nil {
				inner := responsePathFromText(string(data))
				if inner != "" && !strings.HasSuffix(inner, "-prompt.txt") {
					path = inner
				}
			}
		}
		if h.writeManagedResponse && path != "" {
			h.writeResponseFile(path, h.managedResponse)
		}
		info.status = "done"
		h.put(info)
		return map[string]any{
			"type": "agent_prompted",
			"agent": map[string]any{
				"name":         info.name,
				"pane_id":      info.paneID,
				"agent_status": "done",
			},
		}, nil
	default:
		return map[string]any{"type": "ok"}, nil
	}
}

func (h *agentHarness) defaultAgentStatus(target string) (string, error) {
	return h.lookup(target).status, nil
}

func (h *agentHarness) defaultAgentInfo(target string) (map[string]any, error) {
	info := h.lookup(target)
	return map[string]any{
		"name":              info.name,
		"pane_id":           info.paneID,
		"agent_status":      info.status,
		"agent":             "claude",
		"interactive_ready": info.interactiveReady,
		"launch_pending":    info.launchPending,
	}, nil
}

func (h *agentHarness) frameFor(t *testing.T, repoRoot, stepID string, action *workflow.AgentAction) StepFrame {
	t.Helper()
	return StepFrame{
		Step: workflow.Step{
			ID:     stepID,
			Action: action,
		},
		StepIndex: 0,
		Values: workflow.TemplateNamespace{
			Inputs:  map[string]any{},
			Steps:   map[string]any{},
			Context: map[string]any{"cwd": repoRoot},
		},
		Opts: StepRunOpts{
			Name:     "m",
			RepoRoot: repoRoot,
			RunID:    "run1",
			Config: config.Config{
				Profiles:       map[string]config.Profile{"claude": {Kind: "claude"}},
				DefaultProfile: "claude",
			},
			Ctx: config.InvocationContext{
				Cwd:         repoRoot,
				WorkspaceID: "w1",
				TabID:       "w1:t1",
				PaneID:      "w1:p1",
			},
			ManagedResponseFiles: &[]string{},
			Deps: RunnerDeps{
				HerdrCall:        h.call,
				NotificationShow: h.notificationShow,
				AgentStatus:      h.status,
				AgentInfo:        h.info,
				PaneClose:        h.paneClose,
				Sleep:            h.clock.Sleep,
				Now:              h.clock.Now,
				ResponseDir:      &h.responseDir,
			},
		},
	}
}

func methods(calls []herdrCallRecord) []string {
	out := make([]string, len(calls))
	for i, c := range calls {
		out[i] = c.method
	}
	return out
}

func countMethod(calls []herdrCallRecord, name string) int {
	n := 0
	for _, c := range calls {
		if c.method == name {
			n++
		}
	}
	return n
}

func requireAgentStep(t *testing.T, frame *StepFrame) StepOutcome {
	t.Helper()
	outcome, err := AgentStep(frame)
	if err != nil {
		t.Fatalf("AgentStep returned error: %v", err)
	}
	return outcome
}

func requireOK(t *testing.T, outcome StepOutcome) {
	t.Helper()
	if !outcome.OK {
		t.Fatalf("OK = false, error = %q", outcome.Error)
	}
}

func requireNotOK(t *testing.T, outcome StepOutcome) {
	t.Helper()
	if outcome.OK {
		t.Fatal("OK = true, want false")
	}
}

func promptText(t *testing.T, calls []herdrCallRecord) string {
	t.Helper()
	c := findCall(calls, "agent.prompt")
	if c == nil {
		t.Fatal("agent.prompt was not called")
	}
	text, ok := c.params["text"].(string)
	if !ok {
		t.Fatalf("agent.prompt text type %T, want string", c.params["text"])
	}
	return text
}

func keysOf(t *testing.T, params map[string]any) []string {
	t.Helper()
	raw, ok := params["keys"]
	if !ok {
		t.Fatal("send_keys params missing keys")
	}
	switch ks := raw.(type) {
	case []string:
		return ks
	case []any:
		out := make([]string, len(ks))
		for i, v := range ks {
			s, ok := v.(string)
			if !ok {
				t.Fatalf("keys[%d] type %T, want string", i, v)
			}
			out[i] = s
		}
		return out
	default:
		t.Fatalf("keys type %T, want []string or []any", raw)
		return nil
	}
}

func sendKeyCalls(calls []herdrCallRecord) []herdrCallRecord {
	var out []herdrCallRecord
	for _, c := range calls {
		if c.method == "agent.send_keys" {
			out = append(out, c)
		}
	}
	return out
}

func requireOneEnterNudge(t *testing.T, calls []herdrCallRecord) {
	t.Helper()
	enters := sendKeyCalls(calls)
	if len(enters) != 1 {
		t.Fatalf("agent.send_keys calls = %d, want 1", len(enters))
	}
	keys := keysOf(t, enters[0].params)
	if !slices.Equal(keys, []string{"enter"}) {
		t.Fatalf("send_keys keys = %v, want [enter]", keys)
	}
}

func besideSummarize() *workflow.AgentAction {
	return &workflow.AgentAction{
		Prompt: "summarize",
		Using:  "claude",
		Pane:   &workflow.PaneSpec{Open: "beside"},
	}
}

func tabBackground() *workflow.AgentAction {
	return &workflow.AgentAction{
		Prompt:     "long job",
		Using:      "claude",
		Background: true,
		Pane:       &workflow.PaneSpec{Open: "tab"},
	}
}

func agentResultOf(t *testing.T, outcome StepOutcome) workflow.AgentResult {
	t.Helper()
	m, ok := outcome.Result.(map[string]any)
	if !ok {
		t.Fatalf("Result type %T, want map[string]any", outcome.Result)
	}
	r := workflow.AgentResult{}
	r.Response, _ = m["response"].(string)
	r.Agent, _ = m["agent"].(map[string]any)
	r.PaneID, _ = m["pane_id"].(string)
	r.Verdict, _ = m["verdict"].(string)
	return r
}

// Ports runner.test.ts "native agent start then prompt order with managed response".
func TestAgentStepStartThenPromptOrder(t *testing.T) {
	repo := t.TempDir()
	h := newAgentHarness(t, repo)
	frame := h.frameFor(t, repo, "review", besideSummarize())

	outcome := requireAgentStep(t, &frame)
	requireOK(t, outcome)

	ms := methods(h.calls)
	split := slices.Index(ms, "pane.split")
	start := slices.Index(ms, "agent.start")
	prompt := slices.Index(ms, "agent.prompt")
	if split < 0 {
		t.Fatalf("pane.split missing in %v", ms)
	}
	if start < 0 {
		t.Fatalf("agent.start missing in %v", ms)
	}
	if prompt < 0 {
		t.Fatalf("agent.prompt missing in %v", ms)
	}
	if split >= start || start >= prompt {
		t.Fatalf("order %v, want pane.split then agent.start then agent.prompt", ms)
	}

	splitCall := findCall(h.calls, "pane.split")
	if splitCall == nil {
		t.Fatal("pane.split was not called")
	}
	if splitCall.params["direction"] != "right" {
		t.Fatalf("split direction = %v, want right", splitCall.params["direction"])
	}
	if splitCall.params["target_pane_id"] != "w1:p1" {
		t.Fatalf("split target_pane_id = %v, want w1:p1", splitCall.params["target_pane_id"])
	}

	got := agentResultOf(t, outcome)
	if got.Response != "managed answer\n" {
		t.Fatalf("Response = %q, want %q", got.Response, "managed answer\n")
	}
}

// Ports runner.test.ts "oversized managed prompts spill to a file; small ones submit directly".
func TestAgentStepPromptSpill(t *testing.T) {
	t.Run("small", func(t *testing.T) {
		repo := t.TempDir()
		h := newAgentHarness(t, repo)
		small := strings.Repeat("x", 100)
		frame := h.frameFor(t, repo, "s", &workflow.AgentAction{
			Prompt: small,
			Using:  "claude",
		})

		outcome := requireAgentStep(t, &frame)
		requireOK(t, outcome)

		text := promptText(t, h.calls)
		if !strings.Contains(text, small) {
			t.Fatalf("prompt text %q does not contain 100 x runes", text)
		}
		if strings.Contains(text, "Read the absolute path") {
			t.Fatalf("prompt text %q contains spill instruction", text)
		}
	})

	t.Run("large", func(t *testing.T) {
		repo := t.TempDir()
		h := newAgentHarness(t, repo)
		large := strings.Repeat("y", caps.AgentPromptByteLimit+64)
		frame := h.frameFor(t, repo, "big", &workflow.AgentAction{
			Prompt: large,
			Using:  "claude",
		})

		outcome := requireAgentStep(t, &frame)
		requireOK(t, outcome)

		text := promptText(t, h.calls)
		if !strings.Contains(text, "Read the absolute path ") {
			t.Fatalf("prompt text %q does not contain %q", text, "Read the absolute path ")
		}
		if strings.Contains(text, large[:80]) {
			t.Fatalf("prompt text contains the first 80 y runes")
		}
		m := spillPathRE.FindStringSubmatch(text)
		if len(m) < 2 {
			t.Fatalf("prompt text %q has no spill path", text)
		}
		if !strings.Contains(m[1], "-prompt.txt") {
			t.Fatalf("spill path %q does not contain -prompt.txt", m[1])
		}
		if frame.Opts.ManagedResponseFiles == nil || !slices.ContainsFunc(*frame.Opts.ManagedResponseFiles, func(p string) bool {
			return strings.HasSuffix(p, "-prompt.txt")
		}) {
			t.Fatalf("ManagedResponseFiles = %v, want a path ending in -prompt.txt", frame.Opts.ManagedResponseFiles)
		}
	})
}

// Ports runner.test.ts "new-agent retries agent_pane_busy once without creating a second pane".
func TestAgentStepRetriesPaneBusyWithoutSecondPane(t *testing.T) {
	repo := t.TempDir()
	h := newAgentHarness(t, repo)
	startAttempts := 0
	base := h.herdrCall
	h.herdrCall = func(method string, params map[string]any) (map[string]any, error) {
		if method == "agent.start" {
			startAttempts++
			if startAttempts == 1 {
				h.record(method, params)
				return nil, &host.HerdrError{
					Code: "agent_pane_busy",
					Msg:  "agent target pane w1:p2 is not an available shell",
				}
			}
		}
		return base(method, params)
	}
	frame := h.frameFor(t, repo, "review", &workflow.AgentAction{
		Prompt: "summarize",
		Using:  "claude",
		Pane:   &workflow.PaneSpec{Open: "tab", Workspace: "w1"},
	})

	outcome := requireAgentStep(t, &frame)
	requireOK(t, outcome)

	if n := countMethod(h.calls, "agent.start"); n != 2 {
		t.Fatalf("agent.start calls = %d, want 2", n)
	}
	if n := countMethod(h.calls, "tab.create"); n != 1 {
		t.Fatalf("tab.create calls = %d, want 1", n)
	}
	if n := countMethod(h.calls, "pane.split"); n != 0 {
		t.Fatalf("pane.split calls = %d, want 0", n)
	}
}

// Ports runner.test.ts "target mode never calls agent.start so agent_pane_busy is not retried".
func TestAgentStepTargetModeNeverStarts(t *testing.T) {
	repo := t.TempDir()
	h := newAgentHarness(t, repo)
	h.put(mockAgent{
		status:           "idle",
		paneID:           "w1:p9",
		name:             "worker",
		interactiveReady: true,
		launchPending:    false,
	})
	base := h.herdrCall
	h.herdrCall = func(method string, params map[string]any) (map[string]any, error) {
		if method == "agent.start" {
			h.record(method, params)
			return nil, &host.HerdrError{
				Code: "agent_pane_busy",
				Msg:  "agent target pane w1:p9 is not an available shell",
			}
		}
		return base(method, params)
	}
	frame := h.frameFor(t, repo, "", &workflow.AgentAction{
		Prompt: "continue",
		Target: "worker",
	})

	outcome := requireAgentStep(t, &frame)
	requireOK(t, outcome)

	if n := countMethod(h.calls, "agent.start"); n != 0 {
		t.Fatalf("agent.start calls = %d, want 0", n)
	}
	if n := countMethod(h.calls, "agent.prompt"); n != 1 {
		t.Fatalf("agent.prompt calls = %d, want 1", n)
	}
}

// Ports runner.test.ts "busy target rejected before prompt".
func TestAgentStepBusyTargetRejectedBeforePrompt(t *testing.T) {
	repo := t.TempDir()
	h := newAgentHarness(t, repo)
	h.agentStatus = func(string) (string, error) { return "working", nil }
	frame := h.frameFor(t, repo, "", &workflow.AgentAction{
		Prompt: "continue",
		Target: "worker",
	})

	outcome := requireAgentStep(t, &frame)
	requireNotOK(t, outcome)
	if !strings.Contains(outcome.Error, "herdr: agent.prompt") {
		t.Fatalf("error = %q, want to contain %q", outcome.Error, "herdr: agent.prompt")
	}
	if n := countMethod(h.calls, "agent.prompt"); n != 0 {
		t.Fatalf("agent.prompt calls = %d, want 0", n)
	}
	want := map[string]any{"target": "worker", "status": "working"}
	if !maps.Equal(outcome.Details, want) {
		t.Fatalf("details = %v, want %v", outcome.Details, want)
	}
}

func TestAgentStepEmptyTarget(t *testing.T) {
	repo := t.TempDir()
	h := newAgentHarness(t, repo)
	frame := h.frameFor(t, repo, "", &workflow.AgentAction{
		Prompt: "continue",
		Target: "{{inputs.missing}}",
	})

	outcome := requireAgentStep(t, &frame)
	requireNotOK(t, outcome)
	if outcome.Error != "agent: target resolved to an empty value" {
		t.Fatalf("error = %q, want %q", outcome.Error, "agent: target resolved to an empty value")
	}
	if n := countMethod(h.calls, "agent.prompt"); n != 0 {
		t.Fatalf("agent.prompt calls = %d, want 0", n)
	}
}

func TestAgentStepUnknownProfileAndMissingDefault(t *testing.T) {
	t.Run("unknown", func(t *testing.T) {
		repo := t.TempDir()
		h := newAgentHarness(t, repo)
		frame := h.frameFor(t, repo, "review", &workflow.AgentAction{
			Prompt: "summarize",
			Using:  "nope",
		})

		outcome := requireAgentStep(t, &frame)
		requireNotOK(t, outcome)
		if outcome.Error != "agent: unknown profile 'nope'" {
			t.Fatalf("error = %q, want %q", outcome.Error, "agent: unknown profile 'nope'")
		}
	})

	t.Run("missing", func(t *testing.T) {
		repo := t.TempDir()
		h := newAgentHarness(t, repo)
		frame := h.frameFor(t, repo, "review", &workflow.AgentAction{
			Prompt: "summarize",
		})
		frame.Opts.Config.DefaultProfile = ""

		outcome := requireAgentStep(t, &frame)
		requireNotOK(t, outcome)
		if !strings.Contains(outcome.Error, "no using: profile and no default_profile is configured") {
			t.Fatalf("error = %q, want to contain %q", outcome.Error, "no using: profile and no default_profile is configured")
		}
		if !strings.Contains(outcome.Error, "hwf init") {
			t.Fatalf("error = %q, want to contain %q", outcome.Error, "hwf init")
		}
	})
}

// Ports runner.test.ts "new-agent that settles without pickup evidence fails as a stalled prompt".
func TestAgentStepStalledPromptNoPickup(t *testing.T) {
	repo := t.TempDir()
	h := newAgentHarness(t, repo)
	h.writeManagedResponse = false
	frame := h.frameFor(t, repo, "review", besideSummarize())

	outcome := requireAgentStep(t, &frame)
	requireNotOK(t, outcome)
	if !strings.Contains(outcome.Error, "was not accepted after 3 attempts") {
		t.Fatalf("error = %q, want to contain %q", outcome.Error, "was not accepted after 3 attempts")
	}
	if withinTimeoutRE.MatchString(outcome.Error) {
		t.Fatalf("error = %q, must not match within \\d+s", outcome.Error)
	}
	if n := countMethod(h.calls, "agent.prompt"); n < 1 {
		t.Fatal("agent.prompt was not called")
	}
}

// Ports runner.test.ts "exhausted prompt attempts fail naming the stalled submission".
func TestAgentStepExhaustedAttemptsNameStall(t *testing.T) {
	repo := t.TempDir()
	h := newAgentHarness(t, repo)
	h.writeManagedResponse = false
	frame := h.frameFor(t, repo, "review", besideSummarize())

	outcome := requireAgentStep(t, &frame)
	requireNotOK(t, outcome)
	if !strings.Contains(outcome.Error, "was not accepted after 3 attempts") {
		t.Fatalf("error = %q, want to contain %q", outcome.Error, "was not accepted after 3 attempts")
	}
	if !strings.Contains(outcome.Error, "never showed working or blocked") {
		t.Fatalf("error = %q, want to contain %q", outcome.Error, "never showed working or blocked")
	}
	if n := countMethod(h.calls, "agent.prompt"); n != 3 {
		t.Fatalf("agent.prompt calls = %d, want 3", n)
	}
}

// Ports runner.test.ts "agent.prompt that starts working immediately gets no enter nudge".
func TestAgentStepImmediateWorkingNoEnterNudge(t *testing.T) {
	repo := t.TempDir()
	h := newAgentHarness(t, repo)
	frame := h.frameFor(t, repo, "review", besideSummarize())

	outcome := requireAgentStep(t, &frame)
	requireOK(t, outcome)
	if n := countMethod(h.calls, "agent.send_keys"); n != 0 {
		t.Fatalf("agent.send_keys calls = %d, want 0", n)
	}
	if n := countMethod(h.calls, "agent.prompt"); n != 1 {
		t.Fatalf("agent.prompt calls = %d, want 1", n)
	}
}

// Ports runner.test.ts "stalled agent.prompt gets exactly one enter nudge then completes".
func TestAgentStepPasteStallEnterNudgeThenCompletes(t *testing.T) {
	repo := t.TempDir()
	h := newAgentHarness(t, repo)
	h.writeManagedResponse = false
	pendingPath := ""
	base := h.herdrCall
	h.herdrCall = func(method string, params map[string]any) (map[string]any, error) {
		if method == "agent.prompt" {
			h.record(method, params)
			text, _ := params["text"].(string)
			pendingPath = responsePathFromText(text)
			target, _ := params["target"].(string)
			info := h.lookup(target)
			info.status = "idle"
			h.put(info)
			return map[string]any{
				"type": "agent_prompted",
				"agent": map[string]any{
					"name":         target,
					"pane_id":      info.paneID,
					"agent_status": "idle",
				},
			}, nil
		}
		if method == "agent.send_keys" {
			h.record(method, params)
			if pendingPath != "" {
				h.writeResponseFile(pendingPath, "nudged answer\n")
			}
			target, _ := params["target"].(string)
			info := h.lookup(target)
			info.status = "done"
			h.put(info)
			return map[string]any{"type": "ok"}, nil
		}
		return base(method, params)
	}
	frame := h.frameFor(t, repo, "review", besideSummarize())

	outcome := requireAgentStep(t, &frame)
	requireOK(t, outcome)
	requireOneEnterNudge(t, h.calls)
	if n := countMethod(h.calls, "agent.prompt"); n != 1 {
		t.Fatalf("agent.prompt calls = %d, want 1", n)
	}
}

func coldPromptThenPickup(h *agentHarness, prompts *int, params map[string]any) map[string]any {
	*prompts++
	h.record("agent.prompt", params)
	text, _ := params["text"].(string)
	path := responsePathFromText(text)
	target, _ := params["target"].(string)
	info := h.lookup(target)
	status := "idle"
	if *prompts >= 2 {
		if path != "" {
			h.writeResponseFile(path, "second try\n")
		}
		info.status = "done"
		status = "working"
	} else {
		info.status = "idle"
	}
	h.put(info)
	return map[string]any{
		"type": "agent_prompted",
		"agent": map[string]any{
			"name":         target,
			"pane_id":      info.paneID,
			"agent_status": status,
		},
	}
}

// Ports runner.test.ts "cold agent that ignores the first prompt gets exactly one re-submit".
func TestAgentStepColdAgentResubmitsOnce(t *testing.T) {
	repo := t.TempDir()
	h := newAgentHarness(t, repo)
	h.writeManagedResponse = false
	prompts := 0
	base := h.herdrCall
	h.herdrCall = func(method string, params map[string]any) (map[string]any, error) {
		if method == "agent.prompt" {
			return coldPromptThenPickup(h, &prompts, params), nil
		}
		return base(method, params)
	}
	frame := h.frameFor(t, repo, "review", besideSummarize())

	outcome := requireAgentStep(t, &frame)
	requireOK(t, outcome)
	if n := countMethod(h.calls, "agent.prompt"); n != 2 {
		t.Fatalf("agent.prompt calls = %d, want 2", n)
	}
	if n := countMethod(h.calls, "pane.split"); n != 1 {
		t.Fatalf("pane.split calls = %d, want 1", n)
	}
}

// Ports runner.test.ts "new-agent settled without a response reminds once then fails after the full grace".
func TestAgentStepSettledWithoutResponseRemindsOnceThenFails(t *testing.T) {
	repo := t.TempDir()
	h := newAgentHarness(t, repo)
	h.writeManagedResponse = false
	polls := 0
	base := h.herdrCall
	h.herdrCall = func(method string, params map[string]any) (map[string]any, error) {
		out, err := base(method, params)
		if method == "agent.prompt" {
			text, _ := params["text"].(string)
			if !strings.Contains(text, "still missing") {
				target, _ := params["target"].(string)
				info := h.lookup(target)
				info.status = "working"
				h.put(info)
				polls = 0
			}
		}
		return out, err
	}
	h.agentStatus = func(target string) (string, error) {
		info := h.lookup(target)
		polls++
		if polls > 3 {
			info.status = "done"
			h.put(info)
		}
		return info.status, nil
	}
	frame := h.frameFor(t, repo, "review", besideSummarize())

	outcome := requireAgentStep(t, &frame)
	requireNotOK(t, outcome)
	if !strings.Contains(outcome.Error, "managed response file was not written") {
		t.Fatalf("error = %q, want to contain %q", outcome.Error, "managed response file was not written")
	}
	if withinTimeoutRE.MatchString(outcome.Error) {
		t.Fatalf("error = %q, must not match within \\d+s", outcome.Error)
	}
	if n := countReminderPrompts(h.calls); n != 1 {
		t.Fatalf("reminder prompts = %d, want 1", n)
	}
}

func countReminderPrompts(calls []herdrCallRecord) int {
	n := 0
	for _, c := range calls {
		if c.method != "agent.prompt" {
			continue
		}
		text, _ := c.params["text"].(string)
		if strings.Contains(text, "still missing") {
			n++
		}
	}
	return n
}

// Ports runner.test.ts "idle flicker shorter than the settled grace does not fail the turn".
func TestAgentStepIdleFlickerShorterThanGraceDoesNotFail(t *testing.T) {
	repo := t.TempDir()
	h := newAgentHarness(t, repo)
	h.writeManagedResponse = false
	responsePath := ""
	polls := 0
	base := h.herdrCall
	h.herdrCall = func(method string, params map[string]any) (map[string]any, error) {
		out, err := base(method, params)
		if method == "agent.prompt" && responsePath == "" {
			text, _ := params["text"].(string)
			responsePath = responsePathFromText(text)
			polls = 0
		}
		return out, err
	}
	h.agentStatus = func(string) (string, error) {
		polls++
		if polls <= 3 {
			return "working", nil
		}
		if polls == 9 && responsePath != "" {
			h.writeResponseFile(responsePath, "late answer\n")
		}
		return "done", nil
	}
	frame := h.frameFor(t, repo, "review", besideSummarize())

	outcome := requireAgentStep(t, &frame)
	requireOK(t, outcome)
	if n := countReminderPrompts(h.calls); n != 0 {
		t.Fatalf("reminder prompts = %d, want 0", n)
	}
}

// Ports runner.test.ts "write-the-file reminder fires once and a response written after it succeeds".
func TestAgentStepWriteFileReminderFiresOnceThenSucceeds(t *testing.T) {
	repo := t.TempDir()
	h := newAgentHarness(t, repo)
	h.writeManagedResponse = false
	responsePath := ""
	polls := 0
	base := h.herdrCall
	h.herdrCall = func(method string, params map[string]any) (map[string]any, error) {
		out, err := base(method, params)
		text, _ := params["text"].(string)
		if method == "agent.prompt" && !strings.Contains(text, "still missing") {
			responsePath = responsePathFromText(text)
			target, _ := params["target"].(string)
			info := h.lookup(target)
			info.status = "working"
			h.put(info)
			polls = 0
		}
		if method == "agent.prompt" && strings.Contains(text, "still missing") && responsePath != "" {
			h.writeResponseFile(responsePath, "reminded answer\n")
		}
		return out, err
	}
	h.agentStatus = func(target string) (string, error) {
		info := h.lookup(target)
		polls++
		if polls > 3 {
			info.status = "done"
			h.put(info)
		}
		return info.status, nil
	}
	frame := h.frameFor(t, repo, "review", besideSummarize())

	outcome := requireAgentStep(t, &frame)
	requireOK(t, outcome)
	if n := countReminderPrompts(h.calls); n != 1 {
		t.Fatalf("reminder prompts = %d, want 1", n)
	}
}

// Ports runner.test.ts "settled-empty grace sends one Enter nudge and accepts a late response".
func TestAgentStepSettledEmptyGraceEnterNudge(t *testing.T) {
	repo := t.TempDir()
	h := newAgentHarness(t, repo)
	h.writeManagedResponse = false
	responsePath := ""
	polls := 0
	base := h.herdrCall
	h.herdrCall = func(method string, params map[string]any) (map[string]any, error) {
		out, err := base(method, params)
		if method == "agent.prompt" {
			text, _ := params["text"].(string)
			responsePath = responsePathFromText(text)
			target, _ := params["target"].(string)
			info := h.lookup(target)
			info.status = "working"
			h.put(info)
			polls = 0
		}
		if method == "agent.send_keys" && responsePath != "" {
			h.writeResponseFile(responsePath, "nudged answer\n")
		}
		return out, err
	}
	h.agentStatus = func(target string) (string, error) {
		info := h.lookup(target)
		polls++
		if polls > 3 {
			info.status = "done"
			h.put(info)
		}
		return info.status, nil
	}
	frame := h.frameFor(t, repo, "review", besideSummarize())

	outcome := requireAgentStep(t, &frame)
	requireOK(t, outcome)
	requireOneEnterNudge(t, h.calls)
}

// Ports runner.test.ts "target mode keeps waiting for managed response until timeout".
func TestAgentStepTargetModeWaitsUntilTimeout(t *testing.T) {
	repo := t.TempDir()
	h := newAgentHarness(t, repo)
	h.writeManagedResponse = false
	h.put(mockAgent{
		status:           "idle",
		paneID:           "w1:p9",
		name:             "worker",
		interactiveReady: true,
		launchPending:    false,
	})
	polls := 0
	base := h.herdrCall
	h.herdrCall = func(method string, params map[string]any) (map[string]any, error) {
		if method == "agent.prompt" {
			h.put(mockAgent{
				status:           "working",
				paneID:           "w1:p9",
				name:             "worker",
				interactiveReady: true,
				launchPending:    false,
			})
			polls = 0
			h.record(method, params)
			return map[string]any{
				"type": "agent_prompted",
				"agent": map[string]any{
					"name":         "worker",
					"pane_id":      "w1:p9",
					"agent_status": "working",
				},
			}, nil
		}
		return base(method, params)
	}
	h.agentStatus = func(string) (string, error) {
		polls++
		if polls > 3 {
			return "idle", nil
		}
		return h.lookup("worker").status, nil
	}
	frame := h.frameFor(t, repo, "", &workflow.AgentAction{
		Prompt:  "continue",
		Target:  "worker",
		Timeout: 200 * time.Millisecond,
	})

	outcome := requireAgentStep(t, &frame)
	requireNotOK(t, outcome)
	if !strings.Contains(outcome.Error, "did not settle with a managed response within 0.2s") {
		t.Fatalf("error = %q, want to contain %q", outcome.Error, "did not settle with a managed response within 0.2s")
	}
	if strings.Contains(outcome.Error, "managed response file was not written") {
		t.Fatalf("error = %q, must not contain %q", outcome.Error, "managed response file was not written")
	}
}

// Ports runner.test.ts "blocked episode notifies once and is recorded in the run log" — notification half only.
func TestAgentStepBlockedEpisodeNotifiesOnce(t *testing.T) {
	repo := t.TempDir()
	h := newAgentHarness(t, repo)
	prompted := false
	polls := 0
	base := h.herdrCall
	h.herdrCall = func(method string, params map[string]any) (map[string]any, error) {
		if method == "agent.prompt" {
			prompted = true
		}
		return base(method, params)
	}
	h.agentStatus = func(target string) (string, error) {
		if !prompted {
			return "idle", nil
		}
		polls++
		if polls <= 2 {
			return "blocked", nil
		}
		return h.defaultAgentStatus(target)
	}
	frame := h.frameFor(t, repo, "review", besideSummarize())

	outcome := requireAgentStep(t, &frame)
	requireOK(t, outcome)

	var blocked []string
	for _, n := range h.notes {
		if strings.Contains(n, "agent blocked") {
			blocked = append(blocked, n)
		}
	}
	if len(blocked) != 1 {
		t.Fatalf("blocked notes = %v, want exactly 1", blocked)
	}
	if !strings.HasPrefix(blocked[0], "herdr-workflows: m agent blocked|") {
		t.Fatalf("note = %q, want title herdr-workflows: m agent blocked", blocked[0])
	}
	if !strings.Contains(blocked[0], "waiting for input at step 0") {
		t.Fatalf("note = %q, want body containing waiting for input at step 0", blocked[0])
	}
}

// Ports runner.test.ts "close always closes the pane when agent.start fails after placement"
// and "close success leaves the pane open when agent.start fails after placement".
func TestAgentStepCloseAlwaysVsSuccessOnStartFailure(t *testing.T) {
	failStart := func(h *agentHarness) {
		base := h.herdrCall
		h.herdrCall = func(method string, params map[string]any) (map[string]any, error) {
			if method == "agent.start" {
				h.record(method, params)
				return nil, &host.HerdrError{Code: "agent_start_failed", Msg: "simulated start failure"}
			}
			return base(method, params)
		}
	}

	t.Run("close always", func(t *testing.T) {
		repo := t.TempDir()
		h := newAgentHarness(t, repo)
		failStart(h)
		frame := h.frameFor(t, repo, "review", &workflow.AgentAction{
			Prompt: "summarize",
			Using:  "claude",
			Pane:   &workflow.PaneSpec{Open: "beside", Close: "always"},
		})

		outcome := requireAgentStep(t, &frame)
		requireNotOK(t, outcome)
		if !slices.Equal(h.closed, []string{"w1:p3"}) {
			t.Fatalf("closed = %v, want [w1:p3]", h.closed)
		}
		if n := countMethod(h.calls, "pane.split"); n != 1 {
			t.Fatalf("pane.split calls = %d, want 1", n)
		}
	})

	t.Run("close success", func(t *testing.T) {
		repo := t.TempDir()
		h := newAgentHarness(t, repo)
		failStart(h)
		frame := h.frameFor(t, repo, "review", &workflow.AgentAction{
			Prompt: "summarize",
			Using:  "claude",
			Pane:   &workflow.PaneSpec{Open: "beside", Close: "success"},
		})

		outcome := requireAgentStep(t, &frame)
		requireNotOK(t, outcome)
		if len(h.closed) != 0 {
			t.Fatalf("closed = %v, want empty", h.closed)
		}
	})
}

// Ports runner.test.ts "background launch whose agent flips idle to done without working fails loudly".
func TestAgentStepBackgroundIdleToDoneIsStall(t *testing.T) {
	repo := t.TempDir()
	h := newAgentHarness(t, repo)
	h.writeManagedResponse = false
	base := h.herdrCall
	h.herdrCall = func(method string, params map[string]any) (map[string]any, error) {
		if method == "agent.prompt" {
			h.record(method, params)
			target, _ := params["target"].(string)
			info := h.lookup(target)
			info.status = "done"
			h.put(info)
			return map[string]any{
				"type": "agent_prompted",
				"agent": map[string]any{
					"name":         target,
					"pane_id":      info.paneID,
					"agent_status": "done",
				},
			}, nil
		}
		return base(method, params)
	}
	frame := h.frameFor(t, repo, "launch", tabBackground())

	outcome := requireAgentStep(t, &frame)
	requireNotOK(t, outcome)
	if !strings.Contains(outcome.Error, "was not accepted after 3 attempts") {
		t.Fatalf("error = %q, want to contain %q", outcome.Error, "was not accepted after 3 attempts")
	}
	if n := countMethod(h.calls, "agent.prompt"); n != 3 {
		t.Fatalf("agent.prompt calls = %d, want 3", n)
	}
}

// Ports runner.test.ts "background launch succeeds once the agent shows working".
func TestAgentStepBackgroundWorkingIsLaunched(t *testing.T) {
	repo := t.TempDir()
	h := newAgentHarness(t, repo)
	h.writeManagedResponse = false
	base := h.herdrCall
	h.herdrCall = func(method string, params map[string]any) (map[string]any, error) {
		if method == "agent.prompt" {
			h.record(method, params)
			target, _ := params["target"].(string)
			info := h.lookup(target)
			info.status = "working"
			h.put(info)
			return map[string]any{
				"type": "agent_prompted",
				"agent": map[string]any{
					"name":         target,
					"pane_id":      info.paneID,
					"agent_status": "working",
				},
			}, nil
		}
		return base(method, params)
	}
	frame := h.frameFor(t, repo, "launch", tabBackground())

	outcome := requireAgentStep(t, &frame)
	requireOK(t, outcome)
	if !outcome.Launched {
		t.Fatal("Launched = false, want true")
	}
	if outcome.Result != nil {
		t.Fatalf("Result = %v, want nil", outcome.Result)
	}
	if n := countMethod(h.calls, "agent.prompt"); n != 1 {
		t.Fatalf("agent.prompt calls = %d, want 1", n)
	}
	if n := countMethod(h.calls, "agent.send_keys"); n != 0 {
		t.Fatalf("agent.send_keys calls = %d, want 0", n)
	}
}

func TestAgentStepInteractiveReadyTimeout(t *testing.T) {
	repo := t.TempDir()
	h := newAgentHarness(t, repo)
	h.interactiveReadyOnStart = false
	h.launchPendingOnStart = true
	frame := h.frameFor(t, repo, "review", besideSummarize())

	outcome := requireAgentStep(t, &frame)
	requireNotOK(t, outcome)
	if !strings.Contains(outcome.Error, "did not become interactive within 30s") {
		t.Fatalf("error = %q, want to contain %q", outcome.Error, "did not become interactive within 30s")
	}
}

func TestAgentStepProcessExitedBeforeInteractive(t *testing.T) {
	repo := t.TempDir()
	h := newAgentHarness(t, repo)
	h.interactiveReadyOnStart = false
	h.launchPendingOnStart = false
	frame := h.frameFor(t, repo, "review", besideSummarize())

	outcome := requireAgentStep(t, &frame)
	requireNotOK(t, outcome)
	if !strings.Contains(outcome.Error, "agent process exited before becoming interactive") {
		t.Fatalf("error = %q, want to contain %q", outcome.Error, "agent process exited before becoming interactive")
	}
}

// Ports the preparedResponsePath rm behind runner.test.ts
// "a parent step's managed response cannot stand in for a child step's turn".
func TestAgentStepLeftoverManagedFileDeletedBeforeTurn(t *testing.T) {
	repo := t.TempDir()
	h := newAgentHarness(t, repo)
	h.writeManagedResponse = false
	path := ManagedResponsePath("run1", 0, h.responseDir)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte("stale answer\n"), 0o600); err != nil {
		t.Fatalf("write stale: %v", err)
	}
	frame := h.frameFor(t, repo, "review", besideSummarize())

	outcome := requireAgentStep(t, &frame)
	requireNotOK(t, outcome)
}
