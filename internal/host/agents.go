package host

import (
	"cmp"
	"fmt"
	"os"
	"slices"
	"strconv"
	"strings"
)

// AgentPane is one live agent pane from agent.list.
type AgentPane struct {
	PaneID string
	Tab    string
	Kind   string
	Status string
	Title  string
	Self   bool
}

// ListAgentPanes gives agent panes from the herdr socket.
func ListAgentPanes() ([]AgentPane, error) {
	result, err := HerdrCall("agent.list", map[string]any{})
	if err != nil {
		return nil, err
	}
	return ParseAgentPanes(result, os.Getenv("HERDR_PANE_ID"))
}

// ParseAgentPanes decodes an agent.list result map. An agent.list record carries
// no title of its own unless agent.rename set a name, so the title degrades.
func ParseAgentPanes(result map[string]any, selfPaneID string) ([]AgentPane, error) {
	if result == nil {
		return nil, fmt.Errorf("empty agent list")
	}
	raw, _ := result["agents"].([]any)
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
		tabID, _ := entry["tab_id"].(string)
		kind, _ := entry["agent"].(string)
		status, _ := entry["agent_status"].(string)
		out = append(out, AgentPane{
			PaneID: paneID,
			Tab:    tabNumber(tabID),
			Kind:   kind,
			Status: status,
			Title:  agentPaneTitle(entry, paneID),
			Self:   selfPaneID != "" && paneID == selfPaneID,
		})
	}
	slices.SortFunc(out, func(a, b AgentPane) int {
		if c := cmp.Compare(tabOrder(a.Tab), tabOrder(b.Tab)); c != 0 {
			return c
		}
		return cmp.Compare(a.PaneID, b.PaneID)
	})
	return out, nil
}

// agentPaneTitle prefers a renamed agent, then the stripped terminal title, which
// herdr loses on a cold restart. The pane id is the last resort, never an empty row.
func agentPaneTitle(entry map[string]any, paneID string) string {
	for _, key := range []string{"name", "terminal_title_stripped"} {
		if text, _ := entry[key].(string); strings.TrimSpace(text) != "" {
			return strings.TrimSpace(text)
		}
	}
	return paneID
}

// tabNumber is the digits of a `w1:t3` tab id. Any other shape keeps the whole id.
func tabNumber(tabID string) string {
	_, after, found := strings.Cut(tabID, ":t")
	if !found || after == "" {
		return tabID
	}
	if _, err := strconv.Atoi(after); err != nil {
		return tabID
	}
	return after
}

// tabOrder sorts numeric tabs ahead of anything else, so tab 10 follows tab 9.
func tabOrder(tab string) int {
	n, err := strconv.Atoi(tab)
	if err != nil {
		return 1 << 30
	}
	return n
}

// PaneSendText writes text into a pane input and does not submit the text.
func PaneSendText(paneID, text string) error {
	_, err := HerdrCall("pane.send_text", map[string]any{
		"pane_id": paneID,
		"text":    text,
	})
	return err
}
