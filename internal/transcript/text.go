package transcript

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/host"
)

// Options holds the invocation context and the host session seam. If GetInfo is
// nil, the default is the real herdr agent-session lookup.
type Options struct {
	InvocationCwd string
	ProjectsBase  string
	GetInfo       func(paneID string) (host.AgentSessionInfo, error)
}

// HasTranscriptSupport is true if an agent kind has a configured extractor or
// built-in Claude support.
func HasTranscriptSupport(agentKind string, transcripts map[string]config.TranscriptExtractor) bool {
	if _, ok := transcripts[agentKind]; ok {
		return true
	}
	return agentKind == "claude"
}

func transcriptEnv(paneID string, info host.AgentSessionInfo, invocationCwd string) []string {
	cwd := info.Cwd
	if cwd == "" {
		cwd = invocationCwd
	}
	env := append([]string{}, os.Environ()...)
	env = append(env,
		"HWF_TRANSCRIPT_PANE_ID="+paneID,
		"HWF_TRANSCRIPT_AGENT_KIND="+info.Agent,
		"HWF_TRANSCRIPT_CWD="+cwd,
	)
	if info.SessionKind != "" {
		env = append(env, "HWF_TRANSCRIPT_SESSION_KIND="+info.SessionKind)
	}
	if info.SessionID != "" {
		env = append(env, "HWF_TRANSCRIPT_SESSION_VALUE="+info.SessionID)
	}
	return env
}

func runTranscriptCommand(argv []string, paneID string, info host.AgentSessionInfo, invocationCwd string) (string, error) {
	cwd := info.Cwd
	if cwd == "" {
		cwd = invocationCwd
	}
	result, err := captureCommand(argv, captureOptions{
		cwd:       cwd,
		env:       transcriptEnv(paneID, info, invocationCwd),
		timeoutMs: transcriptTimeoutMs,
	})
	if err != nil {
		return "", err
	}
	if result.timedOut {
		return "", &host.HerdrError{Code: "transcript_command_failed", Msg: fmt.Sprintf("transcript command for '%s' failed: timed out after %ds", info.Agent, result.timeoutMs/1000)}
	}
	if result.exitCode != 0 {
		tail := strings.TrimSpace(result.stderr)
		if tail == "" {
			tail = fmt.Sprintf("exit %d", result.exitCode)
		}
		if runes := []rune(tail); len(runes) > 500 {
			tail = string(runes[len(runes)-500:])
		}
		return "", &host.HerdrError{Code: "transcript_command_failed", Msg: fmt.Sprintf("transcript command for '%s' failed: %s", info.Agent, tail)}
	}
	if strings.TrimSpace(result.stdout) == "" {
		return "", &host.HerdrError{Code: "transcript_command_empty", Msg: fmt.Sprintf("transcript command for '%s' printed nothing", info.Agent)}
	}
	if err := caps.AssertUnderCaptureCap("transcript", result.stdout); err != nil {
		return "", err
	}
	return result.stdout, nil
}

// Text gives the text transcript for the agent session of a pane. The source
// is a configured extractor command or the built-in Claude extractor.
func Text(paneID string, transcripts map[string]config.TranscriptExtractor, opts Options) (string, error) {
	getInfo := opts.GetInfo
	if getInfo == nil {
		getInfo = host.GetAgentSessionInfo
	}
	info, err := getInfo(paneID)
	if err != nil {
		return "", err
	}
	if extractor, ok := transcripts[info.Agent]; ok {
		return runTranscriptCommand(extractor.Command, paneID, info, opts.InvocationCwd)
	}
	if !HasTranscriptSupport(info.Agent, transcripts) {
		return "", &host.HerdrError{Code: "transcript_unsupported_kind", Msg: fmt.Sprintf("no transcript extractor for '%s' and no built-in support for that kind", info.Agent)}
	}
	cwd := info.Cwd
	if cwd == "" {
		cwd = opts.InvocationCwd
	}
	if info.SessionID == "" {
		return "", &host.HerdrError{Code: "transcript_unsupported_kind", Msg: fmt.Sprintf("no transcript extractor for '%s' and built-in support requires a native session value", info.Agent)}
	}
	base := opts.ProjectsBase
	if base == "" {
		home, err := config.HomeDir(nil)
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".claude", "projects")
	}
	return ReadClaudeTranscript(cwd, info.SessionID, base)
}
