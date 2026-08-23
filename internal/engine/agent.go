package engine

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

const agentNameMax = 32

// normalizedPrefix normalizes a prefix by lowercasing, collapsing runs of
// non-[a-z0-9_-] into single dashes, stripping leading non-letters, and
// falling back to "agent" if nothing remains.
func normalizedPrefix(raw string) string {
	lowered := strings.ToLower(raw)
	// Replace runs of non-[a-z0-9_-] with single dash
	re := regexp.MustCompile(`[^a-z0-9_-]+`)
	collapsed := re.ReplaceAllString(lowered, "-")
	// Strip leading non-letters
	stripped := strings.TrimLeftFunc(collapsed, func(r rune) bool {
		return r < 'a' || r > 'z'
	})
	if stripped == "" {
		return "agent"
	}
	return stripped
}

// GenerateAgentName generates a herdr identifier from a step ID (or ordinal
// fallback), ordinal, and suffix, respecting the 32-character budget and
// identifier rule ^[a-z][a-z0-9_-]{0,31}$.
func GenerateAgentName(stepID string, ordinal int, suffix string) string {
	// Normalize suffix: lowercase and drop non-alphanumeric, fallback to "0"
	tail := strings.ToLower(suffix)
	re := regexp.MustCompile(`[^a-z0-9]+`)
	tail = re.ReplaceAllString(tail, "")
	if tail == "" {
		tail = "0"
	}

	// Prefix is stepID or "step-<ordinal>"
	prefixRaw := stepID
	if prefixRaw == "" {
		prefixRaw = fmt.Sprintf("step-%d", ordinal)
	}

	prefix := normalizedPrefix(prefixRaw)

	// Calculate room for prefix, minus the '-' separator and tail
	room := agentNameMax - len(tail) - 1
	if room < 1 {
		room = 1
	}

	// Truncate prefix and build result
	result := fmt.Sprintf("%s-%s", prefix[:min(len(prefix), room)], tail)

	// Final cap at 32 chars (should already fit, but be safe)
	if len(result) > agentNameMax {
		result = result[:agentNameMax]
	}

	return result
}

// ManagedResponsePath returns the file path for a managed agent response.
func ManagedResponsePath(runID string, stepIndex int, responseDir string) string {
	return filepath.Join(responseDir, fmt.Sprintf("%s-step-%d.txt", runID, stepIndex))
}

// ManagedPromptSpillPath returns the file path for a spilled agent prompt.
func ManagedPromptSpillPath(runID string, stepIndex int, responseDir string) string {
	return filepath.Join(responseDir, fmt.Sprintf("%s-step-%d-prompt.txt", runID, stepIndex))
}

// ReadManagedResponse reads the managed response file, with size checks before
// and after decoding.
func ReadManagedResponse(path string) (string, error) {
	// Check if file exists
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", &host.HerdrError{
				Code: "managed_response_missing",
				Msg:  fmt.Sprintf("managed response file was not written: %s", path),
			}
		}
		return "", err
	}

	// Check file size before reading
	if info.Size() > int64(caps.CaptureByteLimit) {
		return "", &caps.CaptureLimitError{
			Source: "managed response",
			Bytes:  int(info.Size()),
			Limit:  caps.CaptureByteLimit,
		}
	}

	// Read file
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}

	text := string(data)

	// Check decoded text against cap
	if err := caps.AssertUnderCaptureCap("managed response", text); err != nil {
		return "", err
	}

	// Check for whitespace-only content
	if strings.TrimSpace(text) == "" {
		return "", &host.HerdrError{
			Code: "managed_response_empty",
			Msg:  fmt.Sprintf("managed response file is empty: %s", path),
		}
	}

	return text, nil
}

// AppendResponseInstruction appends instructions to a prompt for managing an
// agent response. If expect is nil, only the file-write instruction is added;
// otherwise the verdict requirement is also added.
func AppendResponseInstruction(prompt string, path string, expect *workflow.ExpectSpec) string {
	base := fmt.Sprintf("%s\n\nRequired: use your file-write tool to write your full answer as plain UTF-8 text to the absolute path %s, overwriting whatever is there. Do not finish until that file exists with your answer. Write nothing else to that path and do not create other files for it. Printing the answer in chat is not enough.", prompt, path)

	if expect == nil {
		return base
	}

	tokens := strings.Join(expect.OneOf, ", ")
	check := fmt.Sprintf("hwf response check %s --one-of %s", QuotePosixArg(path), strings.Join(expect.OneOf, ","))
	return fmt.Sprintf("%s\n\nRequired verdict: the final non-empty line of that file must be exactly one of these tokens and nothing else: %s. Put your reasoning above it. Before you finish the turn, run `%s` and correct the file until that command exits 0.", base, tokens, check)
}

// SpilledPromptInstruction returns the instruction text for reading a spilled
// prompt from a file.
func SpilledPromptInstruction(spillPath string) string {
	return fmt.Sprintf("Read the absolute path %s as UTF-8 and follow its instructions exactly. Do not invent content beyond that file.", spillPath)
}

// ApplyVerdict applies the verdict rule: parsing the response's final
// non-empty line and checking it against the expect spec.
func ApplyVerdict(response string, expect workflow.ExpectSpec, details map[string]any) (string, StepOutcome) {
	parsed, ok, line := workflow.ParseVerdict(response, expect.OneOf)

	if !ok {
		return "", StepOutcome{
			OK:      false,
			Error:   fmt.Sprintf("agent: %s", workflow.VerdictMismatchMessage(line, expect.OneOf)),
			Details: details,
		}
	}

	if len(expect.Require) > 0 {
		// Check if parsed verdict is in the require list
		found := false
		for _, req := range expect.Require {
			if req == parsed {
				found = true
				break
			}
		}

		if !found {
			// Build merged details with the verdict key
			merged := make(map[string]any)
			for k, v := range details {
				merged[k] = v
			}
			merged["verdict"] = parsed

			return "", StepOutcome{
				OK:      false,
				Error:   fmt.Sprintf("agent: %s", workflow.VerdictNotRequiredMessage(parsed, expect.Require)),
				Details: merged,
			}
		}
	}

	return parsed, StepOutcome{
		OK: true,
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

const (
	turnTimeout               = 30 * time.Minute
	pollInterval              = 1 * time.Second
	settledEmptyGracePolls    = 120
	settledEmptyRepromptPolls = 10
	shellReadyDeadline        = 5 * time.Second
	shellReadyPoll            = 50 * time.Millisecond
	agentInteractiveDeadline  = 30 * time.Second
	agentInteractivePoll      = 100 * time.Millisecond
	submitPickupDeadline      = 10 * time.Second
	submitPickupPoll          = 100 * time.Millisecond
	submitEnterFollowup       = 5 * time.Second
	submitMaxAttempts         = 3
	submitRetryBackoff        = 2 * time.Second
)

type managedWaitMode string

const (
	managedWaitNewAgent managedWaitMode = "new-agent"
	managedWaitTarget   managedWaitMode = "target"
)

func depsNow(deps RunnerDeps) time.Time {
	if deps.Now != nil {
		return deps.Now()
	}
	return time.Now()
}

func depsSleep(deps RunnerDeps, d time.Duration) {
	if deps.Sleep != nil {
		deps.Sleep(d)
		return
	}
	time.Sleep(d)
}

func isSettledStatus(status string) bool {
	return status == "idle" || status == "done"
}

func jsonNumber(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	default:
		return 0, false
	}
}

func processInfoRecord(result map[string]any) map[string]any {
	info, ok := result["process_info"].(map[string]any)
	if ok && info != nil {
		return info
	}
	return result
}

func isAvailableShellProcessInfo(info map[string]any) bool {
	shellPid, ok := jsonNumber(info["shell_pid"])
	if !ok {
		return false
	}
	fg, ok := jsonNumber(info["foreground_process_group_id"])
	if !ok || fg != shellPid {
		return false
	}
	procs, ok := info["foreground_processes"].([]any)
	if !ok || len(procs) != 1 {
		return false
	}
	only, ok := procs[0].(map[string]any)
	if !ok {
		return false
	}
	pid, ok := jsonNumber(only["pid"])
	return ok && pid == shellPid
}

func startAgentWhenShellReady(deps RunnerDeps, params map[string]any) error {
	deadline := depsNow(deps).Add(shellReadyDeadline)
	var lastBusy *host.HerdrError
	for depsNow(deps).Before(deadline) {
		shellReady := false
		result, err := deps.HerdrCall("pane.process_info", map[string]any{"pane_id": params["pane_id"]})
		if err == nil {
			shellReady = isAvailableShellProcessInfo(processInfoRecord(result))
		}
		if shellReady {
			if err := tryAgentStart(deps, params, &lastBusy); err == nil {
				return nil
			} else if lastBusy == nil {
				return err
			}
		}
		depsSleep(deps, shellReadyPoll)
	}
	if lastBusy != nil {
		return lastBusy
	}
	_, err := deps.HerdrCall("agent.start", params)
	return err
}

func tryAgentStart(deps RunnerDeps, params map[string]any, lastBusy **host.HerdrError) error {
	_, err := deps.HerdrCall("agent.start", params)
	if err == nil {
		return nil
	}
	var herdr *host.HerdrError
	if errors.As(err, &herdr) && herdr.Code == "agent_pane_busy" {
		*lastBusy = herdr
		return err
	}
	*lastBusy = nil
	return err
}

func awaitAgentInteractiveReady(deps RunnerDeps, name string) error {
	deadline := depsNow(deps).Add(agentInteractiveDeadline)
	for {
		agent, err := deps.AgentInfo(name)
		if err != nil {
			return err
		}
		if agent["interactive_ready"] == true {
			return nil
		}
		if agent["launch_pending"] == false {
			return &host.HerdrError{
				Code: "agent_start_failed",
				Msg:  "agent process exited before becoming interactive",
			}
		}
		if !depsNow(deps).Before(deadline) {
			return &host.HerdrError{
				Code: "agent_start_timeout",
				Msg: fmt.Sprintf(
					"agent '%s' did not become interactive within %gs",
					name,
					agentInteractiveDeadline.Seconds(),
				),
			}
		}
		depsSleep(deps, agentInteractivePoll)
	}
}

type profileChoice struct {
	ok      bool
	name    string
	profile config.Profile
	error   string
}

func chooseProfile(frame *StepFrame, action *workflow.AgentAction) profileChoice {
	name := action.Using
	if name != "" {
		name = workflow.SubstituteText(name, frame.Values)
	} else {
		name = frame.Opts.Config.DefaultProfile
	}
	if name == "" {
		global, _ := config.GlobalConfigPath(nil)
		hint := config.ConfigPathsHint(global, config.RepoConfigPath(frame.Opts.RepoRoot))
		return profileChoice{
			error: fmt.Sprintf(
				"agent: no using: profile and no default_profile is configured (%s); run `hwf init` or `hwf init --global`",
				hint,
			),
		}
	}
	profile, ok := config.ResolveProfile(frame.Opts.Config, name)
	if !ok {
		return profileChoice{error: fmt.Sprintf("agent: unknown profile '%s'", name)}
	}
	return profileChoice{ok: true, name: name, profile: profile}
}

func responseDirOf(frame *StepFrame) string {
	if frame.Opts.Deps.ResponseDir != nil {
		return *frame.Opts.Deps.ResponseDir
	}
	return RunScratchDir(frame.Opts.RepoRoot)
}

func preparedResponsePath(frame *StepFrame) (string, error) {
	path := ManagedResponsePath(frame.Opts.RunID, frame.StepIndex, responseDirOf(frame))
	if _, err := EnsureRunScratchDir(frame.Opts.RepoRoot, filepath.Dir(path)); err != nil {
		return "", err
	}
	// context: child workflows reuse runId with step indexes restarting at 0;
	// a leftover parent file must not count as this turn's pickup.
	_ = os.Remove(path)
	trackManagedResponseFile(&frame.Opts, path)
	return path, nil
}

func fileHasText(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Size() > 0
}

func missingManagedError(path string) string {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return fmt.Sprintf("managed response file was not written: %s", path)
	}
	return fmt.Sprintf("managed response file is empty: %s", path)
}

func missingResponseReminder(path string) string {
	return fmt.Sprintf(
		"Your chat turn ended but the required response file is still missing. Use your file-write tool to write your full answer as plain UTF-8 text to the absolute path %s now, overwriting whatever is there. Printing the answer in chat is not enough — the workflow only reads that file.",
		path,
	)
}

func formatTurnTimeout(timeout time.Duration) string {
	return fmt.Sprintf("%gs", timeout.Seconds())
}

func awaitManagedTurn(
	frame *StepFrame,
	target, path string,
	timeout time.Duration,
	mode managedWaitMode,
) (bool, string) {
	deps := frame.Opts.Deps
	deadline := depsNow(deps).Add(timeout)
	notifiedBlocked := false
	sawActive := false
	settledEmptyPolls := 0
	remindedEmpty := false
	for {
		status, err := deps.AgentStatus(target)
		if err != nil {
			return false, err.Error()
		}
		hasText := fileHasText(path)
		if isSettledStatus(status) && hasText {
			return true, ""
		}
		if !isSettledStatus(status) {
			sawActive = true
		}

		if handleSettledEmpty(deps, mode, status, hasText, sawActive, target, path, &settledEmptyPolls, &remindedEmpty) {
			return false, missingManagedError(path)
		}

		notifiedBlocked = notifyBlockedIfNeeded(frame, deps, target, status, notifiedBlocked)

		if !depsNow(deps).Before(deadline) {
			return false, fmt.Sprintf(
				"agent turn on '%s' did not settle with a managed response within %s (last status %s)",
				target,
				formatTurnTimeout(timeout),
				status,
			)
		}
		depsSleep(deps, pollInterval)
	}
}

func handleSettledEmpty(
	deps RunnerDeps,
	mode managedWaitMode,
	status string,
	hasText, sawActive bool,
	target, path string,
	settledEmptyPolls *int,
	remindedEmpty *bool,
) bool {
	emptySettled := mode == managedWaitNewAgent &&
		isSettledStatus(status) &&
		!hasText &&
		(status == "done" || sawActive)
	if !emptySettled {
		*settledEmptyPolls = 0
		return false
	}
	*settledEmptyPolls++
	if *settledEmptyPolls == 1 {
		_, _ = deps.HerdrCall("agent.send_keys", map[string]any{
			"target": target,
			"keys":   []string{"enter"},
		})
	}
	if !*remindedEmpty && *settledEmptyPolls >= settledEmptyRepromptPolls {
		*remindedEmpty = true
		_, _ = deps.HerdrCall("agent.prompt", map[string]any{
			"target": target,
			"text":   missingResponseReminder(path),
		})
	}
	return *settledEmptyPolls > settledEmptyGracePolls
}

func notifyBlockedIfNeeded(
	frame *StepFrame,
	deps RunnerDeps,
	target, status string,
	notifiedBlocked bool,
) bool {
	if status != "blocked" {
		return false
	}
	if notifiedBlocked {
		return true
	}
	if deps.NotificationShow != nil {
		title := fmt.Sprintf("herdr-workflows: %s agent blocked", frame.Opts.Name)
		body := fmt.Sprintf("%s is waiting for input at step %d", target, frame.StepIndex)
		_ = deps.NotificationShow(title, &body)
	}
	return true
}

func agentDetails(parts struct {
	profile string
	kind    string
	target  string
	pane    *PlacedPane
	paneID  string
	status  string
},
) map[string]any {
	out := map[string]any{}
	if parts.profile != "" {
		out["profile"] = parts.profile
	}
	if parts.kind != "" {
		out["kind"] = parts.kind
	}
	if parts.target != "" {
		out["target"] = parts.target
	}
	if parts.pane != nil {
		out["pane_id"] = parts.pane.PaneID
		out["tab_id"] = parts.pane.TabID
		out["workspace_id"] = parts.pane.WorkspaceID
	} else if parts.paneID != "" {
		out["pane_id"] = parts.paneID
	}
	if parts.status != "" {
		out["status"] = parts.status
	}
	return out
}

func managedResult(
	frame *StepFrame,
	target, path string,
	timeout time.Duration,
	mode managedWaitMode,
	details map[string]any,
	expect *workflow.ExpectSpec,
) StepOutcome {
	settled, waitErr := awaitManagedTurn(frame, target, path, timeout, mode)
	if !settled {
		return StepOutcome{OK: false, Error: waitErr, Details: details}
	}
	response, err := ReadManagedResponse(path)
	if err != nil {
		return managedReadFailure(err, details)
	}
	agent, err := frame.Opts.Deps.AgentInfo(target)
	if err != nil {
		return managedReadFailure(err, details)
	}
	pane := paneIDFrom(details, agent)
	result := map[string]any{
		"response": response,
		"agent":    agent,
		"pane_id":  pane,
	}
	if expect == nil {
		return StepOutcome{OK: true, Result: result}
	}
	verdict, gate := ApplyVerdict(response, *expect, details)
	if !gate.OK {
		return gate
	}
	result["verdict"] = verdict
	return StepOutcome{OK: true, Result: result}
}

func managedReadFailure(err error, details map[string]any) StepOutcome {
	var herdr *host.HerdrError
	message := err.Error()
	if !errors.As(err, &herdr) {
		message = fmt.Sprintf("managed response: %s", err.Error())
	}
	return StepOutcome{OK: false, Error: message, Details: details}
}

func paneIDFrom(details map[string]any, agent map[string]any) string {
	if pane, ok := details["pane_id"].(string); ok && pane != "" {
		return pane
	}
	if pane, ok := agent["pane_id"].(string); ok {
		return pane
	}
	return ""
}

func promptAccepted(deps RunnerDeps, target string, responsePath string, hasPath bool) (bool, error) {
	status, err := deps.AgentStatus(target)
	if err != nil {
		return false, err
	}
	if status == "working" || status == "blocked" {
		return true, nil
	}
	return hasPath && fileHasText(responsePath), nil
}

func waitForPromptPickup(deps RunnerDeps, target string, deadline time.Duration, responsePath string, hasPath bool) (bool, error) {
	until := depsNow(deps).Add(deadline)
	for depsNow(deps).Before(until) {
		ok, err := promptAccepted(deps, target, responsePath, hasPath)
		if err != nil {
			return false, err
		}
		if ok {
			return true, nil
		}
		depsSleep(deps, submitPickupPoll)
	}
	return promptAccepted(deps, target, responsePath, hasPath)
}

func maybeSpillAgentPrompt(frame *StepFrame, text string) (string, error) {
	if len(text) <= caps.AgentPromptByteLimit {
		return text, nil
	}
	if err := caps.AssertUnderCaptureCap("agent prompt", text); err != nil {
		return "", err
	}
	spill := ManagedPromptSpillPath(frame.Opts.RunID, frame.StepIndex, responseDirOf(frame))
	if _, err := EnsureRunScratchDir(frame.Opts.RepoRoot, filepath.Dir(spill)); err != nil {
		return "", err
	}
	if err := os.WriteFile(spill, []byte(text), 0o600); err != nil {
		return "", err
	}
	trackManagedResponseFile(&frame.Opts, spill)
	return SpilledPromptInstruction(spill), nil
}

func submitPrompt(frame *StepFrame, target, text string, responsePath string, hasPath bool) error {
	deps := frame.Opts.Deps
	body, err := maybeSpillAgentPrompt(frame, text)
	if err != nil {
		return err
	}
	for attempt := 1; attempt <= submitMaxAttempts; attempt++ {
		if attempt > 1 {
			ok, err := promptAccepted(deps, target, responsePath, hasPath)
			if err != nil {
				return err
			}
			if ok {
				return nil
			}
		}
		if _, err := deps.HerdrCall("agent.prompt", map[string]any{"target": target, "text": body}); err != nil {
			return err
		}
		ok, err := waitForPromptPickup(deps, target, submitPickupDeadline, responsePath, hasPath)
		if err != nil {
			return err
		}
		if ok {
			return nil
		}
		if _, err := deps.HerdrCall("agent.send_keys", map[string]any{
			"target": target,
			"keys":   []string{"enter"},
		}); err != nil {
			return err
		}
		ok, err = waitForPromptPickup(deps, target, submitEnterFollowup, responsePath, hasPath)
		if err != nil {
			return err
		}
		if ok {
			return nil
		}
		if attempt < submitMaxAttempts {
			depsSleep(deps, submitRetryBackoff)
		}
	}
	return &host.HerdrError{
		Code: "agent_prompt_stalled",
		Msg: fmt.Sprintf(
			"agent prompt to '%s' was not accepted after %d attempts — agent never showed working or blocked (a cold agent CLI can drop input typed before it listens)",
			target,
			submitMaxAttempts,
		),
	}
}

func closePane(frame *StepFrame, placed PlacedPane) {
	if frame.Opts.Deps.PaneClose == nil {
		return
	}
	_ = frame.Opts.Deps.PaneClose(placed.PaneID)
}

func paneFocus(pane *workflow.PaneSpec, background bool) bool {
	if pane.Focus != nil {
		return *pane.Focus
	}
	return !background
}

func placeNewAgentPane(frame *StepFrame, action *workflow.AgentAction) (string, PlacedPane, error) {
	pane := action.Pane
	if pane == nil {
		pane = &workflow.PaneSpec{Open: "tab"}
	}
	open, err := ResolvePaneOpen(pane.Open, frame.Values)
	if err != nil {
		return "", PlacedPane{}, err
	}
	cwd := frame.Opts.Ctx.Cwd
	if action.Cwd != "" {
		cwd = workflow.SubstituteText(action.Cwd, frame.Values)
	}
	env := map[string]string{}
	for k, v := range action.Env {
		env[k] = workflow.SubstituteText(v, frame.Values)
	}
	fallback := frame.Step.ID
	if fallback == "" {
		fallback = "hwf-agent"
	}
	placed, err := PlaceEmptyPane(PlaceOpts{
		Open:       open,
		Anchor:     substituteOptional(pane.Anchor, frame.Values),
		Workspace:  substituteOptional(pane.Workspace, frame.Values),
		Size:       pane.Size,
		Focus:      paneFocus(pane, action.Background),
		Cwd:        cwd,
		Env:        env,
		Label:      ResolvePaneLabel(pane.Name, frame.Values, fallback),
		Deps:       frame.Opts.Deps,
		Invocation: frame.Opts.Ctx,
	})
	if err != nil {
		return "", PlacedPane{}, err
	}
	name := GenerateAgentName(frame.Step.ID, frame.StepIndex, frame.Opts.RunID)
	return name, placed, nil
}

func substituteOptional(text string, ns workflow.TemplateNamespace) string {
	if text == "" {
		return ""
	}
	return workflow.SubstituteText(text, ns)
}

func profileArgs(profile config.Profile) []string {
	if profile.Args == nil {
		return []string{}
	}
	return profile.Args
}

func bootNewAgent(deps RunnerDeps, name string, profile config.Profile, placed PlacedPane) error {
	params := map[string]any{
		"name":    name,
		"kind":    profile.Kind,
		"pane_id": placed.PaneID,
		"args":    profileArgs(profile),
	}
	if err := startAgentWhenShellReady(deps, params); err != nil {
		return err
	}
	return awaitAgentInteractiveReady(deps, name)
}

func agentTimeout(action *workflow.AgentAction) time.Duration {
	if action.Timeout == 0 {
		return turnTimeout
	}
	return action.Timeout
}

func withFailureDetails(failure StepOutcome, details map[string]any) StepOutcome {
	if failure.OK {
		return failure
	}
	failure.Details = details
	return failure
}

func newAgentTurn(frame *StepFrame, action *workflow.AgentAction) StepOutcome {
	chosen := chooseProfile(frame, action)
	if !chosen.ok {
		return StepOutcome{OK: false, Error: chosen.error}
	}
	var placementName string
	var placed PlacedPane
	var hasPlacement bool
	closePolicy := ""
	if action.Pane != nil {
		closePolicy = action.Pane.Close
	}
	baseDetails := func() map[string]any {
		parts := struct {
			profile string
			kind    string
			target  string
			pane    *PlacedPane
			paneID  string
			status  string
		}{
			profile: chosen.name,
			kind:    chosen.profile.Kind,
		}
		if hasPlacement {
			parts.target = placementName
			p := placed
			parts.pane = &p
		}
		return agentDetails(parts)
	}
	defer func() {
		if closePolicy == "always" && hasPlacement {
			closePane(frame, placed)
		}
	}()

	name, pane, err := placeNewAgentPane(frame, action)
	if err != nil {
		return withFailureDetails(DispatchFailure(fmt.Sprintf("agent (profile %s)", chosen.name), err), baseDetails())
	}
	placementName = name
	placed = pane
	hasPlacement = true

	if err := bootNewAgent(frame.Opts.Deps, name, chosen.profile, placed); err != nil {
		return withFailureDetails(DispatchFailure(fmt.Sprintf("agent (profile %s)", chosen.name), err), baseDetails())
	}

	prompt := workflow.SubstituteText(action.Prompt, frame.Values)
	if action.Background {
		if err := submitPrompt(frame, name, prompt, "", false); err != nil {
			return withFailureDetails(DispatchFailure(fmt.Sprintf("agent (profile %s)", chosen.name), err), baseDetails())
		}
		return StepOutcome{OK: true, Launched: true}
	}

	path, err := preparedResponsePath(frame)
	if err != nil {
		return withFailureDetails(DispatchFailure(fmt.Sprintf("agent (profile %s)", chosen.name), err), baseDetails())
	}
	if err := submitPrompt(frame, name, AppendResponseInstruction(prompt, path, action.Expect), path, true); err != nil {
		return withFailureDetails(DispatchFailure(fmt.Sprintf("agent (profile %s)", chosen.name), err), baseDetails())
	}
	outcome := managedResult(frame, name, path, agentTimeout(action), managedWaitNewAgent, baseDetails(), action.Expect)
	if outcome.OK && closePolicy == "success" {
		closePane(frame, placed)
	}
	return outcome
}

func targetTurn(frame *StepFrame, action *workflow.AgentAction, rawTarget string) StepOutcome {
	target := workflow.SubstituteText(rawTarget, frame.Values)
	if target == "" {
		return StepOutcome{OK: false, Error: "agent: target resolved to an empty value"}
	}
	details := agentDetails(struct {
		profile string
		kind    string
		target  string
		pane    *PlacedPane
		paneID  string
		status  string
	}{target: target})

	status, err := frame.Opts.Deps.AgentStatus(target)
	if err != nil {
		return withFailureDetails(DispatchFailure(fmt.Sprintf("agent (target %s)", target), err), details)
	}
	if !isSettledStatus(status) {
		return StepOutcome{
			OK:    false,
			Error: fmt.Sprintf("agent target '%s' is %s — herdr cannot correlate a queued turn; use 'herdr: agent.prompt' to queue work deliberately", target, status),
			Details: agentDetails(struct {
				profile string
				kind    string
				target  string
				pane    *PlacedPane
				paneID  string
				status  string
			}{target: target, status: status}),
		}
	}

	prompt := workflow.SubstituteText(action.Prompt, frame.Values)
	if action.Background {
		if err := submitPrompt(frame, target, prompt, "", false); err != nil {
			return withFailureDetails(DispatchFailure(fmt.Sprintf("agent (target %s)", target), err), details)
		}
		return StepOutcome{OK: true, Launched: true}
	}

	path, err := preparedResponsePath(frame)
	if err != nil {
		return withFailureDetails(DispatchFailure(fmt.Sprintf("agent (target %s)", target), err), details)
	}
	if err := submitPrompt(frame, target, AppendResponseInstruction(prompt, path, action.Expect), path, true); err != nil {
		return withFailureDetails(DispatchFailure(fmt.Sprintf("agent (target %s)", target), err), details)
	}
	return managedResult(frame, target, path, agentTimeout(action), managedWaitTarget, details, action.Expect)
}

func asAgentAction(action workflow.Action) (*workflow.AgentAction, bool) {
	switch a := action.(type) {
	case *workflow.AgentAction:
		return a, true
	case workflow.AgentAction:
		cp := a
		return &cp, true
	default:
		return nil, false
	}
}

// AgentStep runs one managed agent turn (new-agent or target mode).
func AgentStep(frame *StepFrame) (StepOutcome, error) {
	action, ok := asAgentAction(frame.Step.Action)
	if !ok {
		return StepOutcome{OK: false, Error: "internal: not an agent step"}, nil
	}
	if action.Target != "" {
		return targetTurn(frame, action, action.Target), nil
	}
	return newAgentTurn(frame, action), nil
}
