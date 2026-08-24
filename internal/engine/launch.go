package engine

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"

	"github.com/aorumbayev/herdr-workflows/internal/config"
)

const decodeLineTail = 64 * 1024

var progressLineRe = regexp.MustCompile(`^\[(\d+)/(\d+)\] (.+)$`)

// LaunchPayload is the stdin JSON for a detached `hwf run --launch-payload`.
type LaunchPayload struct {
	Name    string              `json:"name"`
	Inputs  map[string]string   `json:"inputs"`
	Domains map[string][]string `json:"domains,omitempty"`
	RunID   string              `json:"runId,omitempty"`
}

// SpawnOpts configures the injectable process seam used by detached launchers.
type SpawnOpts struct {
	Env    map[string]string
	Stdin  string
	Stdout string
	Stderr any
	Cwd    string
}

// Spawned is a started child with optional pipes and a settled exit code.
type Spawned struct {
	Stdin    io.WriteCloser
	Stdout   io.ReadCloser
	Stderr   io.ReadCloser
	ExitCode int
	waitExit func() int
}

// DetachedRunResult is the settled outcome of a detached run child.
type DetachedRunResult struct {
	OK     bool
	Detail string
}

// DetachedRunHandle observes a detached run; Detach settles early like Bun unref.
type DetachedRunHandle struct {
	Result chan DetachedRunResult
	Detach func()
}

// LaunchRunRequest launches a detached `hwf run` with a stdin launch payload.
type LaunchRunRequest struct {
	Name           string
	RepoRoot       string
	Executable     string
	Ctx            config.InvocationContext
	Inputs         map[string]string
	Domains        map[string][]string
	RunID          string
	Env            map[string]string
	OnProgressLine func(string)
	OnHistoryAck   func(string)
	Spawn          func(argv []string, opts SpawnOpts) (*Spawned, error)
}

type progressLine struct {
	Index   int
	Total   int
	Label   string
	Outcome ProgressOutcome
}

// RecordedOutcomeKind maps a step outcome to the recorded history kind.
func RecordedOutcomeKind(outcome StepOutcome) StepOutcomeKind {
	if !outcome.OK {
		if outcome.CoordinationLost {
			return OutcomeInterrupted
		}
		return OutcomeFailed
	}
	if outcome.Launched {
		return OutcomeLaunched
	}
	return OutcomeSucceeded
}

// ParseLaunchPayload validates and decodes a detached-run stdin payload.
func ParseLaunchPayload(text string) (LaunchPayload, error) {
	var raw any
	if err := json.Unmarshal([]byte(text), &raw); err != nil {
		return LaunchPayload{}, errors.New("launch payload is not valid JSON")
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return LaunchPayload{}, errors.New("launch payload must be a JSON object")
	}
	return parseLaunchPayloadObject(obj)
}

func parseLaunchPayloadObject(obj map[string]any) (LaunchPayload, error) {
	nameVal, hasName := obj["name"]
	name, nameOK := nameVal.(string)
	if !hasName || !nameOK || name == "" {
		return LaunchPayload{}, errors.New("launch payload requires a string name")
	}

	inputs := map[string]string{}
	if rawInputs, exists := obj["inputs"]; exists {
		inputObj, ok := rawInputs.(map[string]any)
		if !ok {
			return LaunchPayload{}, errors.New("launch payload inputs must be an object")
		}
		for key, val := range inputObj {
			s, ok := val.(string)
			if !ok {
				return LaunchPayload{}, fmt.Errorf("launch payload inputs.%s must be a string", key)
			}
			inputs[key] = s
		}
	}

	var domains map[string][]string
	if rawDomains, exists := obj["domains"]; exists {
		domainObj, ok := rawDomains.(map[string]any)
		if !ok {
			return LaunchPayload{}, errors.New("launch payload domains must be an object")
		}
		domains = make(map[string][]string, len(domainObj))
		for key, val := range domainObj {
			arr, ok := val.([]any)
			if !ok {
				return LaunchPayload{}, fmt.Errorf("launch payload domains.%s must be a string array", key)
			}
			out := make([]string, len(arr))
			for i, item := range arr {
				s, ok := item.(string)
				if !ok {
					return LaunchPayload{}, fmt.Errorf("launch payload domains.%s must be a string array", key)
				}
				out[i] = s
			}
			domains[key] = out
		}
	}

	var runID string
	if rawRunID, exists := obj["runId"]; exists {
		s, ok := rawRunID.(string)
		if !ok || s == "" {
			return LaunchPayload{}, errors.New("launch payload runId must be a non-empty string")
		}
		runID = s
	}

	return LaunchPayload{Name: name, Inputs: inputs, Domains: domains, RunID: runID}, nil
}

// BuildIdentity returns inode:mtimeMs:size for the compiled executable, or empty values when entry is a script.
// A compiled Go binary is a regular file, so the function keeps the identity when entry is the same as execPath.
func BuildIdentity(entry, execPath string) (string, bool) {
	if entry != "" && entry != execPath {
		if fi, err := os.Stat(entry); err == nil && fi.Mode().IsRegular() {
			return "", false
		}
	}
	fi, err := os.Stat(execPath)
	if err != nil {
		return "", false
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return "", false
	}
	return fmt.Sprintf("%d:%d:%d", st.Ino, fi.ModTime().UnixMilli(), fi.Size()), true
}

func selfArgv(executable, command string, args ...string) []string {
	if executable == "" {
		executable = os.Args[0]
	}
	out := make([]string, 0, 2+len(args))
	out = append(out, executable, command)
	return append(out, args...)
}

func buildInvocationEnv(ctx config.InvocationContext, repoRoot string) map[string]string {
	jsonObj := map[string]any{
		"selected_text": ctx.Selection,
		"workspace_cwd": ctx.Cwd,
	}
	if ctx.PaneID != "" {
		jsonObj["focused_pane_id"] = ctx.PaneID
	}
	if ctx.TabID != "" {
		jsonObj["tab_id"] = ctx.TabID
	}
	if ctx.WorkspaceID != "" {
		jsonObj["workspace_id"] = ctx.WorkspaceID
	}
	if ctx.WorktreePath != "" {
		jsonObj["worktree"] = map[string]any{"checkout_path": ctx.WorktreePath}
	}
	raw, _ := json.Marshal(jsonObj)
	env := map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": repoRoot,
		"HERDR_PLUGIN_CONTEXT_JSON": string(raw),
	}
	if ctx.PaneID != "" {
		env["HERDR_PANE_ID"] = ctx.PaneID
	}
	if ctx.TabID != "" {
		env["HERDR_TAB_ID"] = ctx.TabID
	}
	if ctx.WorkspaceID != "" {
		env["HERDR_WORKSPACE_ID"] = ctx.WorkspaceID
	}
	return env
}

func buildLaunchPayload(name string, inputs map[string]string, domains map[string][]string, runID string) LaunchPayload {
	if inputs == nil {
		inputs = map[string]string{}
	}
	payload := LaunchPayload{Name: name, Inputs: inputs}
	if len(domains) > 0 {
		payload.Domains = domains
	}
	if runID != "" {
		payload.RunID = runID
	}
	return payload
}

func environMap() map[string]string {
	env := make(map[string]string, len(os.Environ()))
	for _, entry := range os.Environ() {
		key, val, ok := strings.Cut(entry, "=")
		if ok {
			env[key] = val
		}
	}
	return env
}

func mergeEnv(base map[string]string, overlays ...map[string]string) map[string]string {
	out := maps.Clone(base)
	if out == nil {
		out = map[string]string{}
	}
	for _, overlay := range overlays {
		maps.Copy(out, overlay)
	}
	return out
}

func parseProgressLine(line string) *progressLine {
	m := progressLineRe.FindStringSubmatch(strings.TrimSpace(line))
	if m == nil {
		return nil
	}
	index, _ := strconv.Atoi(m[1])
	total, _ := strconv.Atoi(m[2])
	rest := m[3]
	if strings.HasSuffix(rest, "…") {
		return &progressLine{Index: index, Total: total, Label: rest[:len(rest)-len("…")], Outcome: ProgressStart}
	}
	for _, outcome := range []ProgressOutcome{ProgressSkip, ProgressFail, ProgressLaunch} {
		suffix := " " + string(outcome)
		if strings.HasSuffix(rest, suffix) {
			return &progressLine{
				Index:   index,
				Total:   total,
				Label:   rest[:len(rest)-len(suffix)],
				Outcome: outcome,
			}
		}
	}
	return &progressLine{Index: index, Total: total, Label: rest, Outcome: ProgressOk}
}

func decodeLines(r io.Reader, onLine func(string)) {
	if r == nil {
		return
	}
	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 4096)
	for {
		n, err := r.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			for {
				nl := bytes.IndexByte(buf, '\n')
				if nl < 0 {
					break
				}
				onLine(string(buf[:nl]))
				buf = buf[nl+1:]
			}
			if len(buf) > decodeLineTail {
				buf = append([]byte(nil), buf[len(buf)-decodeLineTail:]...)
			}
		}
		if err != nil {
			break
		}
	}
	if len(buf) > decodeLineTail {
		buf = buf[len(buf)-decodeLineTail:]
	}
	if len(buf) > 0 {
		onLine(string(buf))
	}
}

func attachSpawnIO(cmd *exec.Cmd, opts SpawnOpts) (stdin io.WriteCloser, stdout, stderr io.ReadCloser, stdinNull *os.File, err error) {
	switch opts.Stdin {
	case "pipe":
		stdin, err = cmd.StdinPipe()
		if err != nil {
			return nil, nil, nil, nil, err
		}
	default:
		stdinNull, err = os.Open(os.DevNull)
		if err != nil {
			return nil, nil, nil, nil, err
		}
		cmd.Stdin = stdinNull
	}
	switch opts.Stdout {
	case "pipe":
		stdout, err = cmd.StdoutPipe()
		if err != nil {
			return nil, nil, nil, stdinNull, err
		}
	default:
		cmd.Stdout = io.Discard
	}
	switch v := opts.Stderr.(type) {
	case *os.File:
		cmd.Stderr = v
	case string:
		if v == "pipe" {
			stderr, err = cmd.StderrPipe()
			if err != nil {
				return nil, nil, nil, stdinNull, err
			}
			break
		}
		cmd.Stderr = io.Discard
	default:
		cmd.Stderr = io.Discard
	}
	return stdin, stdout, stderr, stdinNull, nil
}

func defaultSpawn(argv []string, opts SpawnOpts) (*Spawned, error) {
	if len(argv) == 0 {
		return nil, errors.New("spawn argv is empty")
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = opts.Cwd
	if opts.Env != nil {
		env := make([]string, 0, len(opts.Env))
		for k, v := range opts.Env {
			env = append(env, k+"="+v)
		}
		cmd.Env = env
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	stdin, stdout, stderr, stdinNull, err := attachSpawnIO(cmd, opts)
	if err != nil {
		if stdinNull != nil {
			_ = stdinNull.Close()
		}
		return nil, err
	}

	if err := cmd.Start(); err != nil {
		if stdinNull != nil {
			_ = stdinNull.Close()
		}
		return nil, err
	}
	if stdinNull != nil {
		_ = stdinNull.Close()
	}
	spawned := &Spawned{Stdin: stdin, Stdout: stdout, Stderr: stderr}
	done := make(chan int, 1)
	go func() {
		waitErr := cmd.Wait()
		code := 0
		if waitErr != nil {
			var ee *exec.ExitError
			if errors.As(waitErr, &ee) {
				code = ee.ExitCode()
			} else {
				code = 1
			}
		}
		done <- code
	}()
	spawned.waitExit = func() int {
		return <-done
	}
	return spawned, nil
}

func resolveSpawn(spawn func(argv []string, opts SpawnOpts) (*Spawned, error)) func(argv []string, opts SpawnOpts) (*Spawned, error) {
	if spawn != nil {
		return spawn
	}
	return defaultSpawn
}

// LaunchDetachedRun spawns a detached run child and observes stdout progress/history lines.
func LaunchDetachedRun(req LaunchRunRequest) DetachedRunHandle {
	spawn := resolveSpawn(req.Spawn)
	argv := selfArgv(req.Executable, "run", req.Name, "--launch-payload")
	payload := buildLaunchPayload(req.Name, req.Inputs, req.Domains, req.RunID)
	payloadBytes, marshalErr := json.Marshal(payload)
	env := mergeEnv(environMap(), req.Env, buildInvocationEnv(req.Ctx, req.RepoRoot))

	resultCh := make(chan DetachedRunResult, 1)
	var mu sync.Mutex
	detached := false
	settled := false
	settleOnce := func(r DetachedRunResult) {
		mu.Lock()
		defer mu.Unlock()
		if settled {
			return
		}
		settled = true
		resultCh <- r
	}
	detach := func() {
		mu.Lock()
		if detached {
			mu.Unlock()
			return
		}
		detached = true
		mu.Unlock()
		settleOnce(DetachedRunResult{OK: true, Detail: "detached"})
	}

	handle := DetachedRunHandle{Result: resultCh, Detach: detach}
	if marshalErr != nil {
		settleOnce(DetachedRunResult{OK: false, Detail: marshalErr.Error()})
		return handle
	}

	spawned, err := spawn(argv, SpawnOpts{
		Env:    env,
		Stdin:  "pipe",
		Stdout: "pipe",
		Stderr: "pipe",
		Cwd:    req.RepoRoot,
	})
	if err != nil {
		settleOnce(DetachedRunResult{OK: false, Detail: err.Error()})
		return handle
	}
	if spawned.Stdin != nil {
		_, _ = spawned.Stdin.Write(payloadBytes)
		_ = spawned.Stdin.Close()
	}

	go observeDetachedRun(req, spawned, &mu, &detached, settleOnce)
	return handle
}

func observeDetachedRun(
	req LaunchRunRequest,
	spawned *Spawned,
	mu *sync.Mutex,
	detached *bool,
	settleOnce func(DetachedRunResult),
) {
	var (
		diagMu                               sync.Mutex
		lastProgress, lastStdout, lastStderr string
	)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		decodeLines(spawned.Stdout, func(line string) {
			trimmed := strings.TrimRight(line, " \t\r\n")
			if trimmed == "" {
				return
			}
			mu.Lock()
			isDetached := *detached
			mu.Unlock()
			if strings.HasPrefix(trimmed, "@hwf-history:") {
				if !isDetached && req.OnHistoryAck != nil {
					req.OnHistoryAck(trimmed)
				}
				return
			}
			if parseProgressLine(trimmed) != nil {
				diagMu.Lock()
				lastProgress = trimmed
				diagMu.Unlock()
				if !isDetached && req.OnProgressLine != nil {
					req.OnProgressLine(trimmed)
				}
				return
			}
			diagMu.Lock()
			lastStdout = trimmed
			diagMu.Unlock()
		})
	}()
	go func() {
		defer wg.Done()
		decodeLines(spawned.Stderr, func(line string) {
			trimmed := strings.TrimRight(line, " \t\r\n")
			if trimmed != "" {
				diagMu.Lock()
				lastStderr = trimmed
				diagMu.Unlock()
			}
		})
	}()
	wg.Wait()
	if spawned.Stdout != nil {
		_ = spawned.Stdout.Close()
	}
	if spawned.Stderr != nil {
		_ = spawned.Stderr.Close()
	}

	code := spawned.ExitCode
	if spawned.waitExit != nil {
		code = spawned.waitExit()
	}

	mu.Lock()
	isDetached := *detached
	mu.Unlock()
	if isDetached {
		return
	}
	if code == 0 {
		settleOnce(DetachedRunResult{OK: true, Detail: ""})
		return
	}
	diagMu.Lock()
	detail := lastStderr
	if detail == "" {
		detail = lastStdout
	}
	if detail == "" {
		detail = lastProgress
	}
	diagMu.Unlock()
	if detail == "" {
		detail = fmt.Sprintf("run exited %d", code)
	}
	settleOnce(DetachedRunResult{OK: false, Detail: detail})
}
