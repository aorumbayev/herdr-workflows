package workflow

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// jsonQuote renders a string exactly as JavaScript JSON.stringify does.
// The observable echo surface uses this escaping, not Go strconv.Quote.
func jsonQuote(s string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return strings.TrimSuffix(buf.String(), "\n")
}

// CommandResult is the natural result of a blocking local command.
type CommandResult struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exit_code"`
	Failed   bool   `json:"failed"`
}

// AgentResult is the natural result of a blocking managed agent turn.
type AgentResult struct {
	Response string         `json:"response"`
	Agent    map[string]any `json:"agent"`
	PaneID   string         `json:"pane_id"`
	Verdict  string         `json:"verdict,omitempty"`
}

// ReadinessResult is the native wait result plus identifiers that the
// placed command creates.
type ReadinessResult struct {
	PaneID      string `json:"pane_id"`
	TabID       string `json:"tab_id"`
	WorkspaceID string `json:"workspace_id"`
}

// StepFailureDetails carries command and verdict diagnostics.
type StepFailureDetails struct {
	Stdout   string `json:"stdout,omitempty"`
	Stderr   string `json:"stderr,omitempty"`
	ExitCode *int   `json:"exit_code,omitempty"`
	Method   string `json:"method,omitempty"`
	Verdict  string `json:"verdict,omitempty"`
}

const (
	AgentInfoField    = "agent"
	AgentVerdictField = "verdict"
	CommandExitField  = "exit_code"
)

var (
	CommandFields = map[string]bool{
		"stdout": true, "stderr": true, "exit_code": true, "failed": true,
	}
	AgentStringFields = map[string]bool{
		"response": true, "pane_id": true,
	}
	ReadinessIDFields = map[string]bool{
		"pane_id": true, "tab_id": true, "workspace_id": true,
	}
	SensitiveContextKeys = map[string]bool{
		"transcript": true, "transcript_file": true,
	}
	CommandFieldTypes = map[string]string{
		"stdout": "string", "stderr": "string", "exit_code": "number", "failed": "boolean",
	}
)

// ParseVerdict applies the one verdict rule that the runner and CLI share.
func ParseVerdict(response string, oneOf []string) (string, bool, string) {
	lines := strings.Split(response, "\n")
	line := ""
	for i := len(lines) - 1; i >= 0; i-- {
		if trimmed := strings.TrimSpace(lines[i]); trimmed != "" {
			line = trimmed
			break
		}
	}
	for _, token := range oneOf {
		if token == line {
			return line, true, ""
		}
	}
	return "", false, line
}

func VerdictMismatchMessage(line string, oneOf []string) string {
	found := "an empty response"
	if line != "" {
		found = jsonQuote(line)
	}
	return fmt.Sprintf("final non-empty line %s is not a verdict token — expected exactly one of: %s", found, strings.Join(oneOf, ", "))
}

func VerdictNotRequiredMessage(verdict string, required []string) string {
	return fmt.Sprintf("verdict %s is not accepted — this step requires one of: %s", verdict, strings.Join(required, ", "))
}

// ParseVerdictTokens decodes the CLI comma-separated verdict option.
func ParseVerdictTokens(raw string) ([]string, error) {
	var tokens []string
	for _, token := range strings.Split(raw, ",") {
		token = strings.TrimSpace(token)
		if token == "" {
			continue
		}
		tokens = append(tokens, token)
	}
	if len(tokens) == 0 {
		return nil, fmt.Errorf("--one-of requires at least one verdict token")
	}
	for _, token := range tokens {
		if !verdictTokenRE.MatchString(token) {
			return nil, fmt.Errorf("invalid verdict token '%s' — must match %s", token, VerdictTokenPattern)
		}
	}
	seen := make(map[string]bool)
	for _, token := range tokens {
		if seen[token] {
			return nil, fmt.Errorf("duplicate verdict token '%s'", token)
		}
		seen[token] = true
	}
	return tokens, nil
}
