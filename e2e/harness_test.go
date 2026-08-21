package e2e_test

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/host"
)

type rpcCall struct {
	Method string
	Params map[string]any
}

type runResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
	Calls    []rpcCall
}

type exampleHarness struct {
	calls      []rpcCall
	mu         sync.Mutex
	root       string
	repoRoot   string
	socketPath string
	clipboard  string
	bin        string
	agent      string
	ln         net.Listener
	nextPane   int
	nextTab    int
	agents     map[string][]string
	runEnv     map[string]string
}

func newExampleHarness(t *testing.T) *exampleHarness {
	t.Helper()
	root, err := os.MkdirTemp("", "hwf-examples-e2e-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("preserving harness root on failure: %s", root)
			return
		}
		_ = os.RemoveAll(root)
	})

	repoRoot := filepath.Join(root, "repo")
	if err := os.MkdirAll(repoRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "agent-state"), 0o755); err != nil {
		t.Fatal(err)
	}

	modRoot, err := findModuleRoot()
	if err != nil {
		t.Fatal(err)
	}
	bin, agent, clipboard, err := writeCommands(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := copyExamples(modRoot, repoRoot); err != nil {
		t.Fatal(err)
	}
	if err := writeConfig(repoRoot, agent); err != nil {
		t.Fatal(err)
	}

	socketPath := filepath.Join(root, "herdr.sock")
	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}

	h := &exampleHarness{
		root:       root,
		repoRoot:   repoRoot,
		socketPath: socketPath,
		clipboard:  clipboard,
		bin:        bin,
		agent:      agent,
		ln:         ln,
		nextPane:   2,
		nextTab:    2,
		agents:     map[string][]string{},
	}
	go h.serve()
	return h
}

func (h *exampleHarness) serve() {
	for {
		conn, err := h.ln.Accept()
		if err != nil {
			return
		}
		go h.handleConn(conn)
	}
}

func (h *exampleHarness) handleConn(conn net.Conn) {
	defer func() { _ = conn.Close() }()
	reader := bufio.NewReader(conn)
	line, err := reader.ReadString('\n')
	if err != nil {
		return
	}
	var req struct {
		ID     string         `json:"id"`
		Method string         `json:"method"`
		Params map[string]any `json:"params"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &req); err != nil {
		return
	}
	result, err := h.respond(req.Method, req.Params)
	if err != nil {
		return
	}
	resp, _ := json.Marshal(map[string]any{"id": req.ID, "result": result})
	_, _ = conn.Write(append(resp, '\n'))
}

func paneInfo(paneID, tabID string) map[string]any {
	if tabID == "" {
		tabID = "w1:t1"
	}
	return map[string]any{
		"pane_id":      paneID,
		"tab_id":       tabID,
		"workspace_id": "w1",
	}
}

func (h *exampleHarness) newTabID() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.nextTab++
	return fmt.Sprintf("w1:t%d", h.nextTab-1)
}

func (h *exampleHarness) newPaneID() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.nextPane++
	return fmt.Sprintf("w1:p%d", h.nextPane-1)
}

func (h *exampleHarness) putAgent(name string, argv []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.agents[name] = argv
}

func (h *exampleHarness) agentArgv(name string) ([]string, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	argv, ok := h.agents[name]
	return argv, ok
}

func (h *exampleHarness) setRunEnv(env map[string]string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.runEnv = env
}

func (h *exampleHarness) runEnvPairs() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	pairs := make([]string, 0, len(h.runEnv))
	for k, v := range h.runEnv {
		pairs = append(pairs, k+"="+v)
	}
	return pairs
}

func (h *exampleHarness) respond(method string, params map[string]any) (map[string]any, error) {
	h.mu.Lock()
	h.calls = append(h.calls, rpcCall{Method: method, Params: params})
	h.mu.Unlock()

	switch method {
	case "ping":
		return map[string]any{
			"type":     "pong",
			"protocol": host.Protocol,
			"version":  host.MinHerdrVersion,
		}, nil
	case "tab.create":
		tabID := h.newTabID()
		paneID := h.newPaneID()
		return map[string]any{
			"type":      "tab_created",
			"tab":       map[string]any{"tab_id": tabID, "workspace_id": "w1"},
			"root_pane": paneInfo(paneID, tabID),
		}, nil
	case "pane.split":
		paneID := h.newPaneID()
		return map[string]any{"type": "pane_info", "pane": paneInfo(paneID, "")}, nil
	case "pane.process_info":
		return map[string]any{
			"type": "pane_process_info",
			"process_info": map[string]any{
				"pane_id":                     params["pane_id"],
				"shell_pid":                   100,
				"foreground_process_group_id": 100,
				"foreground_processes": []map[string]any{
					{"pid": 100, "name": "sh", "argv": []string{"sh"}, "argv0": "sh"},
				},
				"tty": "/dev/null",
			},
		}, nil
	case "agent.get":
		target := fmt.Sprint(params["target"])
		status := "done"
		if b, err := os.ReadFile(filepath.Join(h.root, "agent-state", target)); err == nil {
			status = strings.TrimSpace(string(b))
		}
		return map[string]any{
			"type": "agent_info",
			"agent": map[string]any{
				"name":              target,
				"pane_id":           target,
				"agent":             "custom",
				"agent_status":      status,
				"interactive_ready": true,
				"launch_pending":    false,
			},
		}, nil
	case "worktree.create", "worktree.open":
		tabID := h.newTabID()
		paneID := h.newPaneID()
		if method == "worktree.open" {
			_ = os.WriteFile(filepath.Join(h.root, "agent-state", "opened-pane"), []byte(paneID), 0o644)
		}
		resultType := "worktree_created"
		if method == "worktree.open" {
			resultType = "worktree_opened"
		}
		return map[string]any{
			"type":      resultType,
			"workspace": map[string]any{"workspace_id": "w1", "label": fmt.Sprint(params["label"])},
			"tab":       map[string]any{"tab_id": tabID, "workspace_id": "w1"},
			"root_pane": paneInfo(paneID, tabID),
		}, nil
	case "tab.rename", "tab.focus":
		return map[string]any{"type": "ok"}, nil
	case "agent.start":
		name := fmt.Sprint(params["name"])
		if params["args"] == nil {
			_ = os.WriteFile(filepath.Join(h.root, "agent-state", name), []byte("idle"), 0o644)
			return map[string]any{
				"type": "agent_started",
				"agent": map[string]any{
					"name":              name,
					"pane_id":           params["pane_id"],
					"agent":             fmt.Sprint(params["kind"]),
					"agent_status":      "idle",
					"interactive_ready": true,
					"launch_pending":    false,
				},
			}, nil
		}
		args, ok := params["args"].([]any)
		if !ok {
			return nil, fmt.Errorf("agent.start args not array")
		}
		if fmt.Sprint(params["kind"]) != "custom" || len(args) == 0 || fmt.Sprint(args[0]) != h.agent {
			return nil, fmt.Errorf("agent.start did not use the configured custom profile")
		}
		argv := make([]string, len(args))
		for i, a := range args {
			argv[i] = fmt.Sprint(a)
		}
		h.putAgent(name, argv)
		_ = os.WriteFile(filepath.Join(h.root, "agent-state", name), []byte("idle"), 0o644)
		return map[string]any{
			"type": "agent_started",
			"agent": map[string]any{
				"name":              name,
				"pane_id":           params["pane_id"],
				"agent":             "custom",
				"agent_status":      "idle",
				"interactive_ready": true,
				"launch_pending":    false,
			},
			"argv": args,
		}, nil
	case "agent.prompt":
		target := fmt.Sprint(params["target"])
		prompt := fmt.Sprint(params["text"])
		re := regexp.MustCompile(`absolute path ([^\s,]+)`)
		matches := re.FindAllStringSubmatch(prompt, -1)
		responsePath := ""
		if len(matches) > 0 {
			responsePath = matches[len(matches)-1][1]
		}
		argv, ok := h.agentArgv(target)
		if !ok {
			return nil, fmt.Errorf("unknown fake agent %s", target)
		}
		cmd := exec.Command(argv[0], responsePath, prompt)
		cmd.Dir = h.repoRoot
		cmd.Env = append(os.Environ(), h.runEnvPairs()...)
		stderr, err := cmd.CombinedOutput()
		if err != nil {
			msg := strings.TrimSpace(string(stderr))
			if msg == "" {
				msg = fmt.Sprintf("fake agent exited %v", err)
			}
			return nil, fmt.Errorf("%s", msg)
		}
		_ = os.WriteFile(filepath.Join(h.root, "agent-state", target), []byte("working"), 0o644)
		return map[string]any{
			"type":  "agent_prompted",
			"agent": map[string]any{"name": target, "pane_id": target, "agent_status": "done"},
		}, nil
	case "notification.show":
		return map[string]any{"type": "notification_show", "shown": true, "reason": nil}, nil
	case "pane.close", "tab.close":
		return map[string]any{"type": "ok"}, nil
	default:
		return nil, fmt.Errorf("unsupported fake Herdr method: %s", method)
	}
}

func (h *exampleHarness) run(name string, inputs map[string]string, extraEnv map[string]string) (runResult, error) {
	h.mu.Lock()
	callOffset := len(h.calls)
	h.mu.Unlock()
	h.setRunEnv(extraEnv)

	args := []string{"run", name}
	for key, value := range inputs {
		args = append(args, "--input", key+"="+value)
	}
	cmd := exec.Command(hwfBinary, args...)
	cmd.Dir = h.repoRoot

	envMap := map[string]string{}
	for _, e := range os.Environ() {
		if i := strings.IndexByte(e, '='); i >= 0 {
			envMap[e[:i]] = e[i+1:]
		}
	}
	for k, v := range extraEnv {
		if v == "" {
			delete(envMap, k)
		} else {
			envMap[k] = v
		}
	}
	envMap["PATH"] = h.bin + string(os.PathListSeparator) + envMap["PATH"]
	pluginContext, _ := json.Marshal(map[string]any{
		"workspace_id":    "w1",
		"tab_id":          "w1:t1",
		"focused_pane_id": "w1:p1",
		"cwd":             h.repoRoot,
	})
	envMap["HERDR_BIN_PATH"] = filepath.Join(h.bin, "herdr")
	envMap["HERDR_CLIENT_SOCKET_PATH"] = filepath.Join(h.root, "client.sock")
	envMap["HERDR_PANE_ID"] = "w1:p1"
	envMap["HERDR_PLUGIN_CONFIG_DIR"] = filepath.Join(h.root, "plugin-config")
	envMap["HERDR_PLUGIN_CONTEXT_JSON"] = string(pluginContext)
	envMap["HERDR_PLUGIN_STATE_DIR"] = filepath.Join(h.root, "state")
	envMap["HERDR_SOCKET_PATH"] = h.socketPath
	envMap["HERDR_TAB_ID"] = "w1:t1"
	envMap["HERDR_WORKFLOWS_REPO_ROOT"] = h.repoRoot
	envMap["HERDR_WORKSPACE_ID"] = "w1"
	envMap["HWF_E2E_CLIPBOARD"] = h.clipboard
	envMap["HWF_E2E_AGENT_STATE"] = filepath.Join(h.root, "agent-state")
	env := make([]string, 0, len(envMap))
	for k, v := range envMap {
		env = append(env, k+"="+v)
	}
	cmd.Env = env

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	exitCode := 0
	if runErr != nil {
		if ee, ok := runErr.(*exec.ExitError); ok {
			exitCode = ee.ExitCode()
		} else {
			return runResult{}, runErr
		}
	}
	h.mu.Lock()
	calls := append([]rpcCall(nil), h.calls[callOffset:]...)
	h.mu.Unlock()
	return runResult{
		ExitCode: exitCode,
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
		Calls:    calls,
	}, nil
}

func writeExecutable(path, body string) error {
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		return err
	}
	return os.Chmod(path, 0o755)
}

func writeCommands(root string) (binDir, agentPath, clipboardPath string, err error) {
	binDir = filepath.Join(root, "bin")
	if err := os.Mkdir(binDir, 0o755); err != nil {
		return "", "", "", err
	}
	agentPath = filepath.Join(binDir, "fake-agent")
	clipboardPath = filepath.Join(root, "clipboard.txt")

	if err := writeExecutable(agentPath, fakeAgentScript); err != nil {
		return "", "", "", err
	}
	if err := writeExecutable(filepath.Join(binDir, "fake-transcript"), fakeTranscriptScript); err != nil {
		return "", "", "", err
	}
	if err := writeExecutable(filepath.Join(binDir, "git"), fakeGitScript); err != nil {
		return "", "", "", err
	}
	clipboardCommand := clipboardScript
	for _, name := range []string{"pbcopy", "wl-copy", "xclip", "xsel"} {
		if err := writeExecutable(filepath.Join(binDir, name), clipboardCommand); err != nil {
			return "", "", "", err
		}
	}
	if err := writeExecutable(filepath.Join(binDir, "herdr"), fakeHerdrCLIScript); err != nil {
		return "", "", "", err
	}
	return binDir, agentPath, clipboardPath, nil
}

func copyExamples(modRoot, repoRoot string) error {
	srcDir := filepath.Join(modRoot, "examples")
	entries, err := os.ReadDir(srcDir)
	if err != nil {
		return err
	}
	dest := filepath.Join(repoRoot, ".hwf", "workflows")
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	for _, ent := range entries {
		if ent.IsDir() || !strings.HasSuffix(ent.Name(), ".yaml") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(srcDir, ent.Name()))
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dest, ent.Name()), data, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func writeConfig(repoRoot, agent string) error {
	if err := os.MkdirAll(filepath.Join(repoRoot, ".hwf"), 0o755); err != nil {
		return err
	}
	body := fmt.Sprintf(`profiles:
  deterministic:
    kind: custom
    args: [%q]
default_profile: deterministic
transcripts:
  custom:
    command: [fake-transcript]
`, agent)
	return os.WriteFile(filepath.Join(repoRoot, ".hwf", "config.yaml"), []byte(body), 0o644)
}

func runOK(t *testing.T, h *exampleHarness, name string, inputs, env map[string]string) []rpcCall {
	t.Helper()
	result, err := h.run(name, inputs, env)
	return successful(t, result, err)
}

func successful(t *testing.T, result runResult, err error) []rpcCall {
	t.Helper()
	if err != nil {
		t.Fatalf("run failed: %v", err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("exitCode = %d stderr = %q", result.ExitCode, result.Stderr)
	}
	if result.Stderr != "" {
		t.Fatalf("stderr = %q", result.Stderr)
	}
	return result.Calls
}

func notifications(calls []rpcCall) []map[string]any {
	out := make([]map[string]any, 0)
	for _, call := range calls {
		if call.Method == "notification.show" {
			out = append(out, call.Params)
		}
	}
	return out
}

func titles(calls []rpcCall) []any {
	out := make([]any, len(notifications(calls)))
	for i, params := range notifications(calls) {
		out[i] = params["title"]
	}
	return out
}

func repoRealpath(t *testing.T, repoRoot string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(repoRoot)
	if err != nil {
		return repoRoot
	}
	abs, err := filepath.Abs(resolved)
	if err != nil {
		return resolved
	}
	return abs
}

const fakeAgentScript = `#!/bin/sh
path=$1
prompt=$2
[ -z "$path" ] && exit 0
case "$prompt" in
  *"prompt rewriter"*) reply="refined prompt" ;;
  *"session-handoff writer"*)
    reply="deterministic handoff"
    mkdir -p .hwf/tmp
    printf '%s' "$reply" > .hwf/tmp/handoff.md
    ;;
  *"Review this diff"*)
    reply="one finding, reported above

${HWF_E2E_REVIEW_VERDICT:-APPROVE}"
    ;;
  *"Critique the proposal"*)
    reply="the plan skips verification

${HWF_E2E_CRITIQUE_VERDICT:-APPROVE}"
    ;;
  *"Write a short, concrete proposal"*) reply="deterministic proposal" ;;
  *"Revise your proposal"*) reply="deterministic revision" ;;
  *) reply="managed reply" ;;
esac
printf '%s' "$reply" > "$path"
`

const fakeTranscriptScript = "#!/bin/sh\nprintf 'deterministic transcript\\n'\n"

const fakeGitScript = `#!/bin/sh
if [ "$1" = "-C" ]; then shift 2; fi
for last in "$@"; do :; done
case "$1 $2" in
  "diff --quiet") [ "${HWF_E2E_GIT_DIRTY:-0}" = 0 ] ;;
  "diff HEAD")
    [ "${HWF_E2E_GIT_DIRTY:-0}" = 1 ] && printf '%s\n' 'diff --git a/x b/x' '+changed'
    exit 0 ;;
  "show-ref --verify") [ "${HWF_E2E_BRANCH_EXISTS:-0}" = 1 ] ;;
  "rev-parse --git-dir") echo .git ;;
  "rev-parse --show-toplevel") pwd ;;
  "remote "*) printf 'origin\nupstream\n' ;;
  "for-each-ref "*)
    case "$last" in
      refs/remotes/*) printf '%s/main\n%s/release\n' "${last#refs/remotes/}" "${last#refs/remotes/}" ;;
      *) printf 'main\nfeature-seed\n' ;;
    esac ;;
  "log --oneline") printf 'abc1234 seed commit on %s\n' "$last" ;;
  "worktree remove") exit 0 ;;
  "branch -d") exit "${HWF_E2E_BRANCH_UNMERGED:-0}" ;;
  *) exit 2 ;;
esac
`

const clipboardScript = `#!/bin/sh
printf '%s:' "$(basename "$0")" > "$HWF_E2E_CLIPBOARD"
cat >> "$HWF_E2E_CLIPBOARD"
`

const fakeHerdrCLIScript = `#!/bin/sh
if [ "$1 $2" = "agent get" ]; then
  target=$3
  status=done
  [ -f "$HWF_E2E_AGENT_STATE/$target" ] && status=$(cat "$HWF_E2E_AGENT_STATE/$target")
  [ "$status" = working ] && echo done > "$HWF_E2E_AGENT_STATE/$target"
  printf '{"result":{"agent":{"name":"%s","pane_id":"%s","agent":"custom","agent_status":"%s","interactive_ready":true,"launch_pending":false,"cwd":"%s","agent_session":{"kind":"fake","value":"session"}}}}\n' "$target" "$target" "$status" "$HERDR_WORKFLOWS_REPO_ROOT"
  exit 0
fi
case "$1 $2" in
  "notification show"|"pane report-metadata") exit 0 ;;
  "agent list")
    pane=
    [ "${HWF_E2E_AGENT_ON_OPEN:-0}" = 1 ] && pane=$(cat "$HWF_E2E_AGENT_STATE/opened-pane" 2>/dev/null || true)
    if [ -n "$pane" ]; then
      printf '{"result":{"agents":[{"name":"claude-%s","pane_id":"%s","agent":"claude","focused":true}]}}\n' \
        "$pane" "$pane"
    else
      printf '{"result":{"agents":[]}}\n'
    fi
    exit 0 ;;
  "worktree list")
    printf '{"result":{"source":{"repo_root":"%s"},"worktrees":[{"is_linked_worktree":true,"branch":"feature-seed","path":"%s-wt","open_workspace_id":"%s"}]}}\n' \
      "$HERDR_WORKFLOWS_REPO_ROOT" "$HERDR_WORKFLOWS_REPO_ROOT" "${HWF_E2E_WORKTREE_WS:-w2}"
    exit 0 ;;
  "worktree remove") exit 0 ;;
esac
printf 'unsupported fake herdr command: %s\n' "$*" >&2
exit 2
`
