package engine

import (
	"fmt"
	"maps"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func ShellArgv(command, shell string) []string {
	switch shell {
	case "sh":
		return []string{"sh", "-c", command}
	case "bash":
		return []string{"bash", "-c", command}
	case "zsh":
		return []string{"zsh", "-c", command}
	case "pwsh":
		return []string{"pwsh", "-NoProfile", "-Command", command}
	case "powershell":
		return []string{"powershell", "-NoProfile", "-Command", command}
	case "cmd":
		return []string{"cmd", "/c", command}
	default:
		return []string{"sh", "-c", command}
	}
}

func NativeProcessTree(goos string) bool {
	return goos == "linux" || goos == "darwin"
}

type CommandOutcome struct {
	OK       bool
	Failed   bool
	TimedOut bool
	Stdout   string
	Stderr   string
	ExitCode int
}

type ShellStepOpts struct {
	Cwd          string
	Stdin        *string
	Env          []string
	TimeoutMs    int
	Shell        string
	SuccessCodes []int
}

type ArgvStepOpts struct {
	Cwd          string
	Env          []string
	TimeoutMs    int
	SuccessCodes []int
}

func formatTimeoutSeconds(ms int) string {
	seconds := float64(ms) / 1000.0
	return strconv.FormatFloat(seconds, 'f', -1, 64)
}

func captureResult(r caps.SpawnResult, successCodes []int) CommandOutcome {
	if len(successCodes) == 0 {
		successCodes = []int{0}
	}

	accepted := !r.TimedOut && slices.Contains(successCodes, r.ExitCode)
	stderr := r.Stderr
	if r.TimedOut && stderr == "" {
		stderr = fmt.Sprintf("timed out after %ss", formatTimeoutSeconds(r.TimeoutMs))
	}

	return CommandOutcome{
		OK:       accepted,
		Failed:   !accepted,
		TimedOut: r.TimedOut,
		Stdout:   r.Stdout,
		Stderr:   stderr,
		ExitCode: r.ExitCode,
	}
}

func RunShellStep(command string, opts ShellStepOpts) (CommandOutcome, error) {
	argv := ShellArgv(command, opts.Shell)

	captureOpts := caps.SpawnOpts{
		Cwd:              opts.Cwd,
		Stdin:            opts.Stdin,
		Env:              opts.Env,
		TimeoutMs:        opts.TimeoutMs,
		MaxCaptureSource: "command output",
	}

	result, err := caps.Spawn(argv, captureOpts)
	if err != nil {
		return CommandOutcome{}, err
	}

	return captureResult(result, opts.SuccessCodes), nil
}

func RunArgvStep(argv []string, opts ArgvStepOpts) (CommandOutcome, error) {
	captureOpts := caps.SpawnOpts{
		Cwd:              opts.Cwd,
		Env:              opts.Env,
		TimeoutMs:        opts.TimeoutMs,
		MaxCaptureSource: "command output",
	}

	result, err := caps.Spawn(argv, captureOpts)
	if err != nil {
		return CommandOutcome{}, err
	}

	return captureResult(result, opts.SuccessCodes), nil
}

func BuildHwfEnv(inputs map[string]any) map[string]string {
	result := make(map[string]string)
	for name, value := range inputs {
		result[fmt.Sprintf("HWF_%s", name)] = workflow.RenderScalar(value)
	}
	return result
}

func MergeStepEnv(inherited []string, hwf, stepEnv map[string]string) []string {
	envMap := make(map[string]string)

	for _, kv := range inherited {
		parts := strings.SplitN(kv, "=", 2)
		if len(parts) == 2 {
			envMap[parts[0]] = parts[1]
		}
	}

	for key, value := range hwf {
		envMap[key] = value
	}

	for key, value := range stepEnv {
		envMap[key] = value
	}

	result := make([]string, 0, len(envMap))
	keys := slices.Sorted(maps.Keys(envMap))
	for _, key := range keys {
		result = append(result, fmt.Sprintf("%s=%s", key, envMap[key]))
	}

	return result
}

func asAction[T any](action workflow.Action) (*T, bool) {
	if a, ok := any(action).(*T); ok {
		return a, true
	}
	if a, ok := any(action).(T); ok {
		return &a, true
	}
	return nil, false
}

func HerdrStep(frame StepFrame) (StepOutcome, error) {
	action, ok := asAction[workflow.HerdrAction](frame.Step.Action)
	if !ok {
		return StepOutcome{OK: false, Error: "internal: not a herdr step"}, nil
	}

	params := workflow.SubstituteParams(action.Params, frame.Values)
	if params == nil {
		params = map[string]any{}
	}

	invalid := host.ValidateHerdrInvocation(action.Method, params, workflow.IsWholeValueTemplate)
	if invalid != nil {
		return StepOutcome{
			OK:      false,
			Error:   invalid.Error(),
			Details: map[string]any{"method": action.Method},
		}, nil
	}

	result, err := frame.Opts.Deps.HerdrCall(action.Method, params)
	if err != nil {
		return DispatchFailure("herdr "+action.Method, err), nil
	}

	outcome := StepOutcome{
		OK:     true,
		Result: result,
	}
	if ReadTruncated(result) {
		outcome.Truncated = true
	}
	return outcome, nil
}

func bindCommandResult(frame StepFrame, outcome CommandOutcome) {
	if frame.Step.ID == "" {
		return
	}

	frame.Values.Steps[frame.Step.ID] = map[string]any{
		"stdout":    outcome.Stdout,
		"stderr":    outcome.Stderr,
		"exit_code": outcome.ExitCode,
		"failed":    outcome.Failed,
	}
}

func commandFailure(outcome CommandOutcome) StepOutcome {
	detail := strings.TrimSpace(outcome.Stderr)
	if detail == "" {
		trimmedStdout := strings.TrimSpace(outcome.Stdout)
		if runes := []rune(trimmedStdout); len(runes) > 500 {
			detail = string(runes[len(runes)-500:])
		} else {
			detail = trimmedStdout
		}
	}
	if detail == "" {
		detail = fmt.Sprintf("exit %d", outcome.ExitCode)
	}

	details := map[string]any{
		"stdout":    outcome.Stdout,
		"stderr":    outcome.Stderr,
		"exit_code": outcome.ExitCode,
	}

	return StepOutcome{
		OK:      false,
		Error:   detail,
		Details: details,
	}
}

func commandArgv(action *workflow.RunAction, ns workflow.TemplateNamespace) []string {
	if action.Payload.IsArgv() {
		argv := make([]string, len(action.Payload.Argv))
		for i, el := range action.Payload.Argv {
			argv[i] = workflow.SubstituteText(el, ns)
		}
		return argv
	}
	return ShellArgv(action.Payload.Command, action.Payload.Shell)
}

func stepEnvValues(env map[string]string, ns workflow.TemplateNamespace) (map[string]string, error) {
	out := make(map[string]string)
	reserved := regexp.MustCompile(`^[Hh][Ww][Ff]_`)

	for key, value := range env {
		if reserved.MatchString(key) {
			return nil, fmt.Errorf("env key '%s' uses the reserved HWF_ prefix", key)
		}
		out[key] = workflow.SubstituteText(value, ns)
	}
	return out, nil
}

func localCommand(
	frame StepFrame,
	action *workflow.RunAction,
	cwd string,
	env []string,
) StepOutcome {
	payload := action.Payload
	successCodes := action.SuccessCodes
	if len(successCodes) == 0 {
		successCodes = []int{0}
	}

	var outcome CommandOutcome
	var err error

	if payload.IsArgv() {
		outcome, err = RunArgvStep(commandArgv(action, frame.Values), ArgvStepOpts{
			Cwd:          cwd,
			Env:          env,
			TimeoutMs:    int(action.Timeout.Milliseconds()),
			SuccessCodes: successCodes,
		})
	} else {
		outcome, err = RunShellStep(payload.Command, ShellStepOpts{
			Cwd:          cwd,
			Env:          env,
			TimeoutMs:    int(action.Timeout.Milliseconds()),
			Shell:        payload.Shell,
			SuccessCodes: successCodes,
		})
	}

	if err != nil {
		if _, ok := err.(*caps.CaptureLimitError); ok {
			return StepOutcome{OK: false, Error: err.Error(), HardFailure: true}
		}
		return StepOutcome{OK: false, Error: "run: " + ErrorText(err), HardFailure: true}
	}

	if outcome.Stderr != "" {
		if frame.Opts.OnStderr != nil {
			frame.Opts.OnStderr(outcome.Stderr)
		}
	}

	if outcome.TimedOut {
		fail := commandFailure(outcome)
		fail.HardFailure = true
		return fail
	}

	bindCommandResult(frame, outcome)

	if outcome.Failed {
		return commandFailure(outcome)
	}

	return StepOutcome{OK: true}
}

func placedCommand(
	frame StepFrame,
	action *workflow.RunAction,
	cwd string,
	paneEnv map[string]string,
) StepOutcome {
	pane := action.Pane
	if pane == nil {
		return StepOutcome{OK: false, Error: "run: background and ready_when require pane:"}
	}

	sub := func(text string) string {
		return workflow.SubstituteText(text, frame.Values)
	}

	open, err := ResolvePaneOpen(pane.Open, frame.Values)
	if err != nil {
		return StepOutcome{OK: false, Error: ErrorText(err)}
	}

	anchor := ""
	if pane.Anchor != "" {
		anchor = sub(pane.Anchor)
	}

	workspace := ""
	if pane.Workspace != "" {
		workspace = sub(pane.Workspace)
	}

	label := ResolvePaneLabel(pane.Name, frame.Values, frame.Step.ID)

	focus := !action.Background
	if pane.Focus != nil {
		focus = *pane.Focus
	}

	placed, err := PlaceCommandPane(PlaceOpts{
		Open:       open,
		Anchor:     anchor,
		Workspace:  workspace,
		Size:       pane.Size,
		Focus:      focus,
		Cwd:        cwd,
		Env:        paneEnv,
		Label:      label,
		Argv:       commandArgv(action, frame.Values),
		Deps:       frame.Opts.Deps,
		Invocation: frame.Opts.Ctx,
	})
	if err != nil {
		return DispatchFailure("run", err)
	}

	if action.Background {
		return StepOutcome{OK: true, Launched: true}
	}

	if action.ReadyWhen == "" || action.Timeout == 0 {
		return StepOutcome{OK: false, Error: "run: placed foreground run requires ready_when and timeout"}
	}

	waitParams := map[string]any{
		"pane_id":    placed.PaneID,
		"source":     "recent",
		"lines":      80,
		"strip_ansi": true,
		"match": map[string]any{
			"type":  "regex",
			"value": action.ReadyWhen,
		},
		"timeout_ms": int(action.Timeout.Milliseconds()),
	}

	waited, err := frame.Opts.Deps.HerdrCall("pane.wait_for_output", waitParams)
	if err != nil {
		return DispatchFailure("run", err)
	}

	result := maps.Clone(waited)
	if result == nil {
		result = map[string]any{}
	}
	result["pane_id"] = placed.PaneID
	result["tab_id"] = placed.TabID
	result["workspace_id"] = placed.WorkspaceID

	outcome := StepOutcome{OK: true, Result: result}
	if ReadTruncated(result) {
		outcome.Truncated = true
	}
	return outcome
}

func ShellStep(frame StepFrame) (StepOutcome, error) {
	action, ok := asAction[workflow.RunAction](frame.Step.Action)
	if !ok {
		return StepOutcome{OK: false, Error: "internal: not a run step"}, nil
	}

	stepEnv, err := stepEnvValues(action.Env, frame.Values)
	if err != nil {
		return StepOutcome{OK: false, Error: err.Error()}, nil
	}

	hwf := mergeEnv(BuildHwfEnv(frame.Values.Inputs), runContextEnv(frame.Opts))

	cwd := frame.Opts.Ctx.Cwd
	if action.Cwd != "" {
		cwd = workflow.SubstituteText(action.Cwd, frame.Values)
	}

	if action.Pane != nil || action.Background || action.ReadyWhen != "" {
		return placedCommand(frame, action, cwd, mergeEnv(hwf, stepEnv)), nil
	}

	env := frame.Opts.Env
	if env == nil {
		env = os.Environ()
	}

	mergedEnv := MergeStepEnv(env, hwf, stepEnv)
	return localCommand(frame, action, cwd, mergedEnv), nil
}

func runContextEnv(opts StepRunOpts) map[string]string {
	out := map[string]string{}
	if opts.RunID != "" {
		out["HWF_RUN_ID"] = opts.RunID
	}
	if opts.Name != "" {
		out["HWF_WORKFLOW"] = opts.Name
	}
	if opts.RepoRoot != "" {
		out["HWF_CHECKOUT_ROOT"] = opts.RepoRoot
	}
	return out
}
