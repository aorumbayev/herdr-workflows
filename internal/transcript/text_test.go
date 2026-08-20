package transcript

import (
	"fmt"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/host"
)

func TestTranscriptTextConfiguredCommand(t *testing.T) {
	cwd := t.TempDir()
	out, err := TranscriptText("pane-1", map[string]config.TranscriptExtractor{
		"claude": {Command: []string{"sh", "-c", `printf 'pane=%s kind=%s cwd=%s sk=%s sv=%s' "$HWF_TRANSCRIPT_PANE_ID" "$HWF_TRANSCRIPT_AGENT_KIND" "$HWF_TRANSCRIPT_CWD" "$HWF_TRANSCRIPT_SESSION_KIND" "$HWF_TRANSCRIPT_SESSION_VALUE"`}},
	}, Options{
		InvocationCwd: "/fallback",
		GetInfo: func(string) (host.AgentSessionInfo, error) {
			return host.AgentSessionInfo{Agent: "claude", SessionID: "sid-9", SessionKind: "id", Cwd: cwd}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := "pane=pane-1 kind=claude cwd=" + cwd + " sk=id sv=sid-9"
	if out != want {
		t.Fatalf("got %q, want %q", out, want)
	}
}

func TestTranscriptTextCwdFallback(t *testing.T) {
	invocationCwd := t.TempDir()
	out, err := TranscriptText("pane-2", map[string]config.TranscriptExtractor{
		"codex": {Command: []string{"sh", "-c", `printf '%s' "$HWF_TRANSCRIPT_CWD"`}},
	}, Options{
		InvocationCwd: invocationCwd,
		GetInfo: func(string) (host.AgentSessionInfo, error) {
			return host.AgentSessionInfo{Agent: "codex"}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if out != invocationCwd {
		t.Fatalf("got %q, want %q", out, invocationCwd)
	}
}

func TestTranscriptTextNonzeroExit(t *testing.T) {
	_, err := TranscriptText("p", map[string]config.TranscriptExtractor{
		"codex": {Command: []string{"sh", "-c", "echo boom >&2; exit 2"}},
	}, Options{
		InvocationCwd: t.TempDir(),
		GetInfo: func(string) (host.AgentSessionInfo, error) {
			return host.AgentSessionInfo{Agent: "codex", SessionID: "s"}, nil
		},
	})
	if err == nil || !strings.Contains(err.Error(), "transcript command for 'codex' failed:") || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("got %v", err)
	}
}

func TestTranscriptTextEmptyStdout(t *testing.T) {
	_, err := TranscriptText("p", map[string]config.TranscriptExtractor{
		"codex": {Command: []string{"sh", "-c", "true"}},
	}, Options{
		InvocationCwd: t.TempDir(),
		GetInfo: func(string) (host.AgentSessionInfo, error) {
			return host.AgentSessionInfo{Agent: "codex", SessionID: "s"}, nil
		},
	})
	if err == nil || !strings.Contains(err.Error(), "transcript command for 'codex' printed nothing") {
		t.Fatalf("got %v", err)
	}
}

func TestTranscriptTextBuiltinClaude(t *testing.T) {
	base := t.TempDir()
	cwd := "/Users/x/y"
	sessionID := "abc123"
	writeSession(t, base, cwd, sessionID, strings.Join([]string{
		"not-json",
		j(map[string]any{"type": "assistant", "message": map[string]any{"content": []any{map[string]any{"type": "tool_use"}}}}),
		j(map[string]any{"type": "user", "message": map[string]any{"content": "builtin"}}),
	}, "\n"))
	out, err := TranscriptText("p", map[string]config.TranscriptExtractor{}, Options{
		InvocationCwd: cwd,
		ProjectsBase:  base,
		GetInfo: func(string) (host.AgentSessionInfo, error) {
			return host.AgentSessionInfo{Agent: "claude", SessionID: sessionID, Cwd: cwd}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if out != "user:\nbuiltin" {
		t.Fatalf("got %q", out)
	}
}

func TestTranscriptTextUnsupportedKind(t *testing.T) {
	_, err := TranscriptText("p", map[string]config.TranscriptExtractor{}, Options{
		InvocationCwd: t.TempDir(),
		GetInfo: func(string) (host.AgentSessionInfo, error) {
			return host.AgentSessionInfo{Agent: "codex", SessionID: "s"}, nil
		},
	})
	if err == nil || !strings.Contains(err.Error(), "no transcript extractor for 'codex'") {
		t.Fatalf("got %v", err)
	}
}

func TestTranscriptTextCaptureCap(t *testing.T) {
	_, err := TranscriptText("p", map[string]config.TranscriptExtractor{
		"claude": {Command: []string{"sh", "-c", fmt.Sprintf("head -c %d /dev/zero", caps.CaptureByteLimit+1)}},
	}, Options{
		InvocationCwd: t.TempDir(),
		GetInfo: func(string) (host.AgentSessionInfo, error) {
			return host.AgentSessionInfo{Agent: "claude", SessionID: "s"}, nil
		},
	})
	if err == nil || !strings.Contains(err.Error(), fmt.Sprintf("exceeded %d byte limit", caps.CaptureByteLimit)) {
		t.Fatalf("got %v", err)
	}
}
