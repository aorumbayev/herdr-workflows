package engine

import (
	"bytes"
	"encoding/json"
	"io"
	"maps"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/config"
)

// capturingStdin records bytes that LaunchDetachedRun writes before Close.
type capturingStdin struct {
	bytes.Buffer
}

func (c *capturingStdin) Close() error { return nil }

type spawnSeen struct {
	argv   []string
	env    map[string]string
	stdin  string
	stdout string
	stderr any
}

func settle(t *testing.T, handle DetachedRunHandle) DetachedRunResult {
	t.Helper()
	select {
	case result := <-handle.Result:
		return result
	case <-t.Context().Done():
		t.Fatal("detached run did not settle before test context ended")
		return DetachedRunResult{}
	case <-time.After(3 * time.Second):
		t.Fatal("detached run did not settle within 3s")
		return DetachedRunResult{}
	}
}

func exitingSpawn(seen *spawnSeen, code int, stdout, stderr string, stdin *capturingStdin) func([]string, SpawnOpts) (*Spawned, error) {
	if stdin == nil {
		stdin = &capturingStdin{}
	}
	return func(argv []string, opts SpawnOpts) (*Spawned, error) {
		seen.argv = slices.Clone(argv)
		seen.env = maps.Clone(opts.Env)
		seen.stdin = opts.Stdin
		seen.stdout = opts.Stdout
		seen.stderr = opts.Stderr
		return &Spawned{
			Stdin:    stdin,
			Stdout:   io.NopCloser(strings.NewReader(stdout)),
			Stderr:   io.NopCloser(strings.NewReader(stderr)),
			ExitCode: code,
		}, nil
	}
}

func TestRecordedOutcomeKind(t *testing.T) {
	cases := []struct {
		name    string
		outcome StepOutcome
		want    StepOutcomeKind
	}{
		{name: "ok", outcome: StepOutcome{OK: true}, want: OutcomeSucceeded},
		{
			name:    "ok with result",
			outcome: StepOutcome{OK: true, Result: map[string]any{"stdout": "hi"}},
			want:    OutcomeSucceeded,
		},
		{name: "ok truncated", outcome: StepOutcome{OK: true, Truncated: true}, want: OutcomeSucceeded},
		{name: "ok launched false", outcome: StepOutcome{OK: true, Launched: false}, want: OutcomeSucceeded},
		{name: "ok launched true", outcome: StepOutcome{OK: true, Launched: true}, want: OutcomeLaunched},
		{name: "fail", outcome: StepOutcome{OK: false, Error: "boom"}, want: OutcomeFailed},
		{
			name:    "fail hard",
			outcome: StepOutcome{OK: false, Error: "boom", HardFailure: true},
			want:    OutcomeFailed,
		},
		{
			name:    "fail with details",
			outcome: StepOutcome{OK: false, Error: "boom", Details: map[string]any{"exit_code": 2}},
			want:    OutcomeFailed,
		},
		{
			name:    "fail coordinationLost false",
			outcome: StepOutcome{OK: false, Error: "boom", CoordinationLost: false},
			want:    OutcomeFailed,
		},
		{
			name:    "fail coordinationLost true",
			outcome: StepOutcome{OK: false, Error: "boom", CoordinationLost: true},
			want:    OutcomeInterrupted,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := RecordedOutcomeKind(tc.outcome)
			if got != tc.want {
				t.Fatalf("RecordedOutcomeKind() = %q, want %q", got, tc.want)
			}
		})
	}
}

// "launch payload forwards domains and round-trips snapshots"
func TestParseLaunchPayloadRoundTrip(t *testing.T) {
	t.Run("inputs", func(t *testing.T) {
		raw := `{"name":"sleep","inputs":{"focus":"x"}}`
		payload, err := ParseLaunchPayload(raw)
		if err != nil {
			t.Fatalf("ParseLaunchPayload: %v", err)
		}
		if payload.Name != "sleep" {
			t.Fatalf("Name = %q, want sleep", payload.Name)
		}
		wantInputs := map[string]string{"focus": "x"}
		if !maps.Equal(payload.Inputs, wantInputs) {
			t.Fatalf("Inputs = %#v, want %#v", payload.Inputs, wantInputs)
		}
		if len(payload.Domains) != 0 {
			t.Fatalf("omitted domains must be nil/empty, got %#v", payload.Domains)
		}
	})

	t.Run("domains", func(t *testing.T) {
		raw := `{"name":"dyn","inputs":{"branch":"one"},"domains":{"branch":["one","two"]}}`
		payload, err := ParseLaunchPayload(raw)
		if err != nil {
			t.Fatalf("ParseLaunchPayload: %v", err)
		}
		if payload.Name != "dyn" {
			t.Fatalf("Name = %q, want dyn", payload.Name)
		}
		wantInputs := map[string]string{"branch": "one"}
		if !maps.Equal(payload.Inputs, wantInputs) {
			t.Fatalf("Inputs = %#v, want %#v", payload.Inputs, wantInputs)
		}
		wantDomains := map[string][]string{"branch": {"one", "two"}}
		if !maps.EqualFunc(payload.Domains, wantDomains, slices.Equal) {
			t.Fatalf("Domains = %#v, want %#v", payload.Domains, wantDomains)
		}
		encoded, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("json.Marshal: %v", err)
		}
		if strings.Contains(string(encoded), "argv") {
			t.Fatalf("marshaled payload must not contain argv: %s", encoded)
		}
	})
}

func TestLaunchDetachedRunCarriesRetryFields(t *testing.T) {
	seen := &spawnSeen{}
	stdin := &capturingStdin{}
	source := "00000000-0000-4000-8000-000000000007"
	handle := LaunchDetachedRun(LaunchRunRequest{
		Name:       "flaky",
		RepoRoot:   "/repo",
		Executable: "/tmp/fake-herdr-workflows",
		Ctx:        config.InvocationContext{Cwd: "/repo"},
		RetryOf:    source,
		FromFailed: true,
		Spawn:      exitingSpawn(seen, 0, "", "", stdin),
	})
	settle(t, handle)
	payload, err := ParseLaunchPayload(stdin.String())
	if err != nil {
		t.Fatalf("ParseLaunchPayload: %v", err)
	}
	if payload.RetryOf != source || !payload.FromFailed {
		t.Fatalf("payload = %+v, want retry fields", payload)
	}
}

func TestParseLaunchPayloadErrors(t *testing.T) {
	cases := []struct {
		raw     string
		wantErr string
	}{
		{raw: `{`, wantErr: "launch payload is not valid JSON"},
		{raw: `[]`, wantErr: "launch payload must be a JSON object"},
		{raw: `{}`, wantErr: "launch payload requires a string name"},
		{raw: `{"name":"x","inputs":[]}`, wantErr: "launch payload inputs must be an object"},
		{raw: `{"name":"x","inputs":{"a":1}}`, wantErr: "launch payload inputs.a must be a string"},
		{raw: `{"name":"x","domains":[]}`, wantErr: "launch payload domains must be an object"},
		{raw: `{"name":"x","domains":{"a":[1]}}`, wantErr: "launch payload domains.a must be a string array"},
		{raw: `{"name":"x","runId":""}`, wantErr: "launch payload runId must be a non-empty string"},
		{raw: `{"name":"x","retryOf":"nope"}`, wantErr: "launch payload retryOf must be a run UUID"},
		{raw: `{"name":"x","retryOf":"00000000-0000-4000-8000-000000000001","fromFailed":"yes"}`, wantErr: "launch payload fromFailed must be a boolean"},
		{raw: `{"name":"x","fromFailed":true}`, wantErr: "launch payload fromFailed requires retryOf"},
	}
	for _, tc := range cases {
		t.Run(tc.wantErr, func(t *testing.T) {
			_, err := ParseLaunchPayload(tc.raw)
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			if err.Error() != tc.wantErr {
				t.Fatalf("error = %q, want %q", err.Error(), tc.wantErr)
			}
		})
	}
}

func TestLaunchDetachedRunPinsCallerEnv(t *testing.T) {
	seen := &spawnSeen{}
	_ = LaunchDetachedRun(LaunchRunRequest{
		Name:       "sleep",
		RepoRoot:   "/repo",
		Executable: "/tmp/fake-herdr-workflows",
		Ctx: config.InvocationContext{
			Selection:    "sel",
			Cwd:          "/repo",
			PaneID:       "wCaller:p1",
			TabID:        "wCaller:t1",
			WorkspaceID:  "wCaller",
			WorktreePath: "/repo/.wt",
		},
		Inputs: map[string]string{},
		Spawn:  exitingSpawn(seen, 0, "", "", nil),
	})

	wantEnv := map[string]string{
		"HERDR_PANE_ID":             "wCaller:p1",
		"HERDR_TAB_ID":              "wCaller:t1",
		"HERDR_WORKSPACE_ID":        "wCaller",
		"HERDR_WORKFLOWS_REPO_ROOT": "/repo",
	}
	for key, want := range wantEnv {
		if seen.env[key] != want {
			t.Fatalf("env[%s] = %q, want %q", key, seen.env[key], want)
		}
	}

	var ctxJSON map[string]any
	if err := json.Unmarshal([]byte(seen.env["HERDR_PLUGIN_CONTEXT_JSON"]), &ctxJSON); err != nil {
		t.Fatalf("HERDR_PLUGIN_CONTEXT_JSON: %v", err)
	}
	if ctxJSON["focused_pane_id"] != "wCaller:p1" {
		t.Fatalf("focused_pane_id = %#v, want wCaller:p1", ctxJSON["focused_pane_id"])
	}
	if ctxJSON["tab_id"] != "wCaller:t1" {
		t.Fatalf("tab_id = %#v, want wCaller:t1", ctxJSON["tab_id"])
	}
	if ctxJSON["workspace_id"] != "wCaller" {
		t.Fatalf("workspace_id = %#v, want wCaller", ctxJSON["workspace_id"])
	}
	if ctxJSON["selected_text"] != "sel" {
		t.Fatalf("selected_text = %#v, want sel", ctxJSON["selected_text"])
	}
	worktree, ok := ctxJSON["worktree"].(map[string]any)
	if !ok {
		t.Fatalf("worktree = %#v, want object", ctxJSON["worktree"])
	}
	if worktree["checkout_path"] != "/repo/.wt" {
		t.Fatalf("worktree.checkout_path = %#v, want /repo/.wt", worktree["checkout_path"])
	}
}

// Go deviation: compiled SelfArgv is [executable, command, ...args] — no script path at argv[1].
func TestLaunchDetachedRunArgv(t *testing.T) {
	seen := &spawnSeen{}
	executable := "/tmp/fake-herdr-workflows"
	_ = LaunchDetachedRun(LaunchRunRequest{
		Name:       "sleep",
		RepoRoot:   "/repo",
		Executable: executable,
		Ctx:        config.InvocationContext{Selection: "", Cwd: "/repo"},
		Inputs:     map[string]string{},
		Spawn:      exitingSpawn(seen, 0, "", "", nil),
	})

	if len(seen.argv) < 3 {
		t.Fatalf("argv length = %d, want at least 3: %#v", len(seen.argv), seen.argv)
	}
	if seen.argv[0] != executable {
		t.Fatalf("argv[0] = %q, want %q", seen.argv[0], executable)
	}
	if !slices.Contains(seen.argv, "run") {
		t.Fatalf("argv missing run: %#v", seen.argv)
	}
	tail := seen.argv[len(seen.argv)-2:]
	wantTail := []string{"sleep", "--launch-payload"}
	if !slices.Equal(tail, wantTail) {
		t.Fatalf("argv[len-2:] = %#v, want %#v", tail, wantTail)
	}
}

// Go deviation: last two elements only — no script path requirement at argv[1].

func TestLaunchDetachedRunPayloadOnStdin(t *testing.T) {
	seen := &spawnSeen{}
	stdin := &capturingStdin{}
	secret := "cred-value-9f3a"
	handle := LaunchDetachedRun(LaunchRunRequest{
		Name:       "safe",
		RepoRoot:   "/repo",
		Executable: "/tmp/fake-herdr-workflows",
		Ctx:        config.InvocationContext{Selection: "", Cwd: "/repo"},
		Inputs:     map[string]string{"token": secret},
		Spawn:      exitingSpawn(seen, 0, "", "", stdin),
	})
	result := settle(t, handle)
	if !result.OK {
		t.Fatalf("result = %#v, want OK", result)
	}
	joined := strings.Join(seen.argv, "\x00")
	if strings.Contains(joined, secret) {
		t.Fatalf("argv must not contain secret input: %#v", seen.argv)
	}
	if len(seen.argv) < 2 {
		t.Fatalf("argv length = %d, want at least 2: %#v", len(seen.argv), seen.argv)
	}
	tail := seen.argv[len(seen.argv)-2:]
	if !slices.Equal(tail, []string{"safe", "--launch-payload"}) {
		t.Fatalf("argv[len-2:] = %#v, want [safe --launch-payload]", tail)
	}
	payload, err := ParseLaunchPayload(stdin.String())
	if err != nil {
		t.Fatalf("ParseLaunchPayload(stdin): %v", err)
	}
	if payload.Inputs["token"] != secret {
		t.Fatalf("payload.Inputs[token] = %q, want %q", payload.Inputs["token"], secret)
	}
	if payload.Name != "safe" {
		t.Fatalf("payload.Name = %q, want safe", payload.Name)
	}
}

func TestLaunchDetachedRunFailedDiagnostic(t *testing.T) {
	seen := &spawnSeen{}
	handle := LaunchDetachedRun(LaunchRunRequest{
		Name:       "ignored",
		RepoRoot:   "/repo",
		Executable: "/tmp/fake-herdr-workflows",
		Ctx:        config.InvocationContext{Selection: "", Cwd: "/repo"},
		Inputs:     map[string]string{},
		Spawn: exitingSpawn(seen, 2,
			"[1/1] run: noisy\nstdout noise one\nstdout noise two\n",
			"stderr line one\nfinal diagnostic\n",
			nil,
		),
	})
	result := settle(t, handle)
	if result.OK {
		t.Fatalf("result.OK = true, want false")
	}
	if result.Detail != "final diagnostic" {
		t.Fatalf("Detail = %q, want final diagnostic", result.Detail)
	}
}

func TestLaunchDetachedRunStderrTail(t *testing.T) {
	seen := &spawnSeen{}
	flood := strings.Repeat("a", 80*1024) + "TAIL-END"
	handle := LaunchDetachedRun(LaunchRunRequest{
		Name:       "ignored",
		RepoRoot:   "/repo",
		Executable: "/tmp/fake-herdr-workflows",
		Ctx:        config.InvocationContext{Selection: "", Cwd: "/repo"},
		Inputs:     map[string]string{},
		Spawn:      exitingSpawn(seen, 2, "[1/1] run: flood\n", flood, nil),
	})
	result := settle(t, handle)
	if result.OK {
		t.Fatalf("result.OK = true, want false")
	}
	if !strings.HasSuffix(result.Detail, "TAIL-END") {
		t.Fatalf("Detail does not end with TAIL-END: %q", trimForLog(result.Detail))
	}
	if len(result.Detail) == 0 {
		t.Fatal("Detail length = 0, want > 0")
	}
	if len(result.Detail) > 64*1024 {
		t.Fatalf("Detail length = %d, want ≤ 64KiB", len(result.Detail))
	}
}

func trimForLog(s string) string {
	if len(s) <= 64 {
		return s
	}
	return "…" + s[len(s)-63:]
}
