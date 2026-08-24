package host

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
)

type cliResult struct {
	stdout   string
	stderr   string
	exitCode int
}

func herdrCLI(args []string) (cliResult, error) {
	bin := BinPath(os.Getenv)
	cmd := exec.Command(bin, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			return cliResult{}, asHerdrError(err, "internal", "herdr CLI failed: "+strings.Join(args, " "))
		}
		return cliResult{stdout: stdout.String(), stderr: stderr.String(), exitCode: exitErr.ExitCode()}, nil
	}
	return cliResult{stdout: stdout.String(), stderr: stderr.String()}, nil
}

// TabClose closes a herdr tab.
func TabClose(tabID string) error {
	_, err := HerdrCall("tab.close", map[string]any{"tab_id": tabID})
	return err
}

// PaneClose closes a herdr pane.
func PaneClose(paneID string) error {
	_, err := HerdrCall("pane.close", map[string]any{"pane_id": paneID})
	return err
}

// PluginPaneOpen opens a plugin pane over the socket, the picker hot path.
func PluginPaneOpen(entrypoint string, env map[string]string, placement string) error {
	pluginID := os.Getenv("HERDR_PLUGIN_ID")
	if pluginID == "" {
		pluginID = "herdr-workflows"
	}
	if env == nil {
		env = map[string]string{}
	}
	var placementVal any = placement
	if placement == "" {
		placementVal = nil
	}
	_, err := HerdrCall("plugin.pane.open", map[string]any{
		"plugin_id":  pluginID,
		"entrypoint": entrypoint,
		"placement":  placementVal,
		"focus":      true,
		"env":        env,
	})
	return err
}

// PluginPaneOpenPopup opens a popup plugin pane at an explicit size. A size is
// either terminal cells or a percent string such as 85%.
func PluginPaneOpenPopup(entrypoint string, env map[string]string, width, height string) error {
	pluginID := os.Getenv("HERDR_PLUGIN_ID")
	if pluginID == "" {
		pluginID = "herdr-workflows"
	}
	if env == nil {
		env = map[string]string{}
	}
	call := map[string]any{
		"plugin_id":  pluginID,
		"entrypoint": entrypoint,
		"placement":  "popup",
		"focus":      true,
		"env":        env,
	}
	if v := popupSize(width); v != nil {
		call["width"] = v
	}
	if v := popupSize(height); v != nil {
		call["height"] = v
	}
	_, err := HerdrCall("plugin.pane.open", call)
	return err
}

// popupSize keeps a cell count an integer and a percent a string, the two
// shapes PopupSize accepts. Anything else means the manifest default.
func popupSize(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	if cells, err := strconv.Atoi(value); err == nil {
		return cells
	}
	if strings.HasSuffix(value, "%") {
		return value
	}
	return nil
}

// NotificationShow posts a herdr notification through the CLI.
func NotificationShow(title string, body ...string) error {
	args := []string{"notification", "show", title}
	if len(body) > 0 && body[0] != "" {
		args = append(args, "--body", body[0])
	}
	res, err := herdrCLI(args)
	if err != nil {
		return err
	}
	if res.exitCode != 0 {
		return &HerdrError{Code: "notification_show_failed", Msg: cliFailureMessage(res, "notification show failed")}
	}
	return nil
}

func cliFailureMessage(res cliResult, fallback string) string {
	if msg := strings.TrimSpace(res.stderr); msg != "" {
		return msg
	}
	if msg := strings.TrimSpace(res.stdout); msg != "" {
		return msg
	}
	return fallback
}

type agentInfo struct {
	Agent        string `json:"agent"`
	AgentStatus  any    `json:"agent_status"`
	AgentSession *struct {
		Value any `json:"value"`
		Kind  any `json:"kind"`
	} `json:"agent_session"`
	Cwd any `json:"cwd"`
}

func agentGet(target string) (*agentInfo, error) {
	res, err := herdrCLI([]string{"agent", "get", target})
	if err != nil {
		return nil, err
	}
	if res.exitCode != 0 {
		msg := strings.TrimSpace(res.stderr)
		if msg == "" {
			msg = "agent get failed"
		}
		return nil, &HerdrError{Code: "agent_status_failed", Msg: msg}
	}
	var parsed struct {
		Result *struct {
			Agent *agentInfo `json:"agent"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(res.stdout)), &parsed); err != nil {
		return nil, &HerdrError{Code: "agent_status_failed", Msg: "agent get returned invalid JSON"}
	}
	if parsed.Result == nil {
		return nil, nil
	}
	return parsed.Result.Agent, nil
}

// AgentStatus reports the connected agent's status string.
func AgentStatus(target string) (string, error) {
	info, err := agentGet(target)
	if err != nil {
		return "", err
	}
	var status string
	ok := false
	if info != nil {
		status, ok = info.AgentStatus.(string)
	}
	if !ok {
		return "", &HerdrError{Code: "agent_status_failed", Msg: "agent get missing agent_status"}
	}
	return status, nil
}

// AgentSessionInfo is the native agent session an extractor consumes.
type AgentSessionInfo struct {
	Agent       string
	SessionID   string
	SessionKind string
	Cwd         string
}

// GetAgentSessionInfo resolves the agent identity and session for a pane.
func GetAgentSessionInfo(paneID string) (AgentSessionInfo, error) {
	info, err := agentGet(paneID)
	if err != nil {
		return AgentSessionInfo{}, err
	}
	if info == nil || info.Agent == "" {
		return AgentSessionInfo{}, &HerdrError{Code: "no_agent_session", Msg: "no agent session detected in this pane"}
	}
	out := AgentSessionInfo{Agent: info.Agent}
	if info.AgentSession != nil {
		if v, ok := info.AgentSession.Value.(string); ok {
			out.SessionID = v
		}
		if k, ok := info.AgentSession.Kind.(string); ok {
			out.SessionKind = k
		}
	}
	if cwd, ok := info.Cwd.(string); ok {
		out.Cwd = cwd
	}
	return out, nil
}

// ReportToken publishes a report-metadata token through the CLI. A nil value
// clears the token; an empty string publishes an empty one.
func ReportToken(paneID string, value *string) error {
	args := []string{"pane", "report-metadata", paneID, "--source", "herdr-workflows"}
	if value == nil {
		args = append(args, "--clear-token", "herdr-workflows")
	} else {
		args = append(args, "--token", "herdr-workflows="+*value, "--ttl-ms", "600000")
	}
	res, err := herdrCLI(args)
	if err != nil {
		return err
	}
	if res.exitCode != 0 {
		return &HerdrError{Code: "report_token_failed", Msg: cliFailureMessage(res, "report token failed")}
	}
	return nil
}

var (
	protocolCheckedMu sync.Mutex
	protocolChecked   bool
)

// EnsureHerdrProtocol performs the one-shot startup check against the
// connected herdr, no-oping when no socket is configured.
func EnsureHerdrProtocol() error {
	protocolCheckedMu.Lock()
	defer protocolCheckedMu.Unlock()
	if protocolChecked {
		return nil
	}
	if os.Getenv("HERDR_SOCKET_PATH") == "" {
		return nil
	}
	result, err := HerdrCall("ping", map[string]any{})
	if err != nil {
		return err
	}
	check := CheckHerdrStartup(result["protocol"], result["version"])
	if !check.Ok {
		return &HerdrError{Code: "protocol_mismatch", Msg: check.Error}
	}
	protocolChecked = true
	return nil
}

// ResetProtocolCheck clears the one-shot startup gate so each CLI invocation
// in-process can observe a fresh ping.
func ResetProtocolCheck() {
	protocolCheckedMu.Lock()
	defer protocolCheckedMu.Unlock()
	protocolChecked = false
}

// PluginPaneOpenPlaced opens a plugin entrypoint at tab, beside, or below.
func PluginPaneOpenPlaced(entrypoint, open string, env map[string]string) error {
	params, err := consoleOpenParams(open)
	if err != nil {
		return err
	}
	pluginID := os.Getenv("HERDR_PLUGIN_ID")
	if pluginID == "" {
		pluginID = "herdr-workflows"
	}
	if env == nil {
		env = map[string]string{}
	}
	call := map[string]any{
		"plugin_id":  pluginID,
		"entrypoint": entrypoint,
		"placement":  params.placement,
		"focus":      true,
		"env":        env,
	}
	if params.direction != "" {
		call["direction"] = params.direction
	}
	if target := strings.TrimSpace(os.Getenv("HERDR_PANE_ID")); target != "" {
		call["target_pane_id"] = target
	}
	_, err = HerdrCall("plugin.pane.open", call)
	return err
}

type consoleOpenMapping struct {
	placement string
	direction string
}

func consoleOpenParams(open string) (consoleOpenMapping, error) {
	switch open {
	case "tab":
		return consoleOpenMapping{placement: "tab"}, nil
	case "beside":
		return consoleOpenMapping{placement: "split", direction: "right"}, nil
	case "below":
		return consoleOpenMapping{placement: "split", direction: "down"}, nil
	default:
		return consoleOpenMapping{}, &HerdrError{Code: "invalid_argument", Msg: "placement must be tab, beside, or below"}
	}
}
