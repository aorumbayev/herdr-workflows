package host

import (
	"cmp"
	"fmt"
	"slices"
)

// AgentPane is one live agent pane from agent.list.
type AgentPane struct {
	PaneID string
	Name   string
	Title  string
}

// ListAgentPanes returns agent panes from the herdr socket.
func ListAgentPanes() ([]AgentPane, error) {
	result, err := HerdrCall("agent.list", map[string]any{})
	if err != nil {
		return nil, err
	}
	return ParseAgentPanes(result)
}

// ParseAgentPanes decodes an agent.list result map.
func ParseAgentPanes(result map[string]any) ([]AgentPane, error) {
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
		name, _ := entry["name"].(string)
		title, _ := entry["title"].(string)
		if title == "" {
			title = name
		}
		out = append(out, AgentPane{PaneID: paneID, Name: name, Title: title})
	}
	slices.SortFunc(out, func(a, b AgentPane) int { return cmp.Compare(a.Title, b.Title) })
	return out, nil
}

// PaneSendText types text into a pane input without submitting it.
func PaneSendText(paneID, text string) error {
	_, err := HerdrCall("pane.send_text", map[string]any{
		"pane_id": paneID,
		"text":    text,
	})
	return err
}
