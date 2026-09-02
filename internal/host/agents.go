package host

import (
	"cmp"
	"fmt"
	"os"
	"slices"
	"strings"
)

// AgentPane is one live agent pane from agent.list, located by the workspace
// and tab labels that workspace.list and tab.list carry.
type AgentPane struct {
	PaneID          string
	Workspace       string
	Tab             string
	TabNumber       int
	Kind            string
	Status          string
	Title           string
	Self            bool
	workspaceNumber int
}

// ListAgentPanes gives agent panes from the herdr socket.
func ListAgentPanes() ([]AgentPane, error) {
	agents, err := HerdrCall("agent.list", map[string]any{})
	if err != nil {
		return nil, err
	}
	workspaces, err := HerdrCall("workspace.list", map[string]any{})
	if err != nil {
		return nil, err
	}
	tabs, err := HerdrCall("tab.list", map[string]any{})
	if err != nil {
		return nil, err
	}
	return ParseAgentPanes(agents, workspaces, tabs, os.Getenv("HERDR_PANE_ID"))
}

type location struct {
	label  string
	number int
}

// ParseAgentPanes joins an agent.list result with workspace.list and tab.list
// results by id. Ids are opaque, so a tab number never comes from the id.
func ParseAgentPanes(agents, workspaces, tabs map[string]any, selfPaneID string) ([]AgentPane, error) {
	if agents == nil {
		return nil, fmt.Errorf("empty agent list")
	}
	workspaceByID := locations(workspaces, "workspaces", "workspace_id")
	tabByID := locations(tabs, "tabs", "tab_id")
	raw, _ := agents["agents"].([]any)
	out := make([]AgentPane, 0, len(raw))
	for _, item := range raw {
		entry, _ := item.(map[string]any)
		if entry == nil {
			continue
		}
		paneID, _ := entry["pane_id"].(string)
		if paneID == "" {
			continue
		}
		workspaceID, _ := entry["workspace_id"].(string)
		tabID, _ := entry["tab_id"].(string)
		kind, _ := entry["agent"].(string)
		status, _ := entry["agent_status"].(string)
		workspace, tab := workspaceByID[workspaceID], tabByID[tabID]
		out = append(out, AgentPane{
			PaneID:          paneID,
			Workspace:       workspace.label,
			Tab:             tab.label,
			TabNumber:       tab.number,
			Kind:            kind,
			Status:          status,
			Title:           agentPaneTitle(entry),
			Self:            selfPaneID != "" && paneID == selfPaneID,
			workspaceNumber: workspace.number,
		})
	}
	slices.SortFunc(out, func(a, b AgentPane) int {
		return cmp.Or(
			cmp.Compare(a.workspaceNumber, b.workspaceNumber),
			cmp.Compare(a.TabNumber, b.TabNumber),
			cmp.Compare(a.PaneID, b.PaneID),
		)
	})
	return out, nil
}

func locations(result map[string]any, listKey, idKey string) map[string]location {
	out := map[string]location{}
	raw, _ := result[listKey].([]any)
	for _, item := range raw {
		entry, _ := item.(map[string]any)
		id, _ := entry[idKey].(string)
		if id == "" {
			continue
		}
		label, _ := entry["label"].(string)
		number, _ := entry["number"].(float64)
		out[id] = location{label: strings.TrimSpace(label), number: int(number)}
	}
	return out
}

// agentPaneTitle prefers a renamed agent, then the stripped terminal title, which
// herdr loses on a cold restart. The pane id is shown beside every row instead.
func agentPaneTitle(entry map[string]any) string {
	for _, key := range []string{"name", "terminal_title_stripped"} {
		if text, _ := entry[key].(string); strings.TrimSpace(text) != "" {
			return strings.TrimSpace(text)
		}
	}
	return ""
}

// PaneSendText writes text into a pane input and does not submit the text.
func PaneSendText(paneID, text string) error {
	_, err := HerdrCall("pane.send_text", map[string]any{
		"pane_id": paneID,
		"text":    text,
	})
	return err
}
