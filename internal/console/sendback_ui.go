package console

import (
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

type diagramMode int

const (
	diagramModeView diagramMode = iota
	diagramModeSelect
	diagramModeInstruction
	diagramModeAgentPick
)

// AgentPaneEntry is one selectable agent pane for send-back.
type AgentPaneEntry struct {
	PaneID string
	Name   string
	Title  string
}

func agentPaneEntriesFromHost(panes []host.AgentPane) []AgentPaneEntry {
	out := make([]AgentPaneEntry, len(panes))
	for i, pane := range panes {
		out[i] = AgentPaneEntry{PaneID: pane.PaneID, Name: pane.Name, Title: pane.Title}
	}
	return out
}

func (m Model) handleDiagramKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch m.diagramMode {
	case diagramModeInstruction:
		return m.handleDiagramInstructionKey(msg)
	case diagramModeAgentPick:
		return m.handleDiagramAgentPickKey(msg)
	case diagramModeSelect:
		return m.handleDiagramSelectKey(msg)
	default:
		return m.handleDiagramViewKey(msg)
	}
}

func (m Model) handleDiagramViewKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.screen = screenWorkflows
		m.status = ""
		m.resetDiagramSendback()
		return m, nil
	case "up":
		if m.diagramScroll > 0 {
			m.diagramScroll--
		}
		return m, nil
	case "down":
		m.diagramScroll++
		return m, nil
	case "v":
		m.diagramMode = diagramModeSelect
		m.diagramNodeCursor = 0
		m.status = ""
		return m, nil
	case "s":
		return m.beginDiagramInstruction()
	}
	return m, nil
}

func (m Model) handleDiagramSelectKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.diagramMode = diagramModeView
		m.status = ""
		return m, nil
	case "up":
		if m.diagramNodeCursor > 0 {
			m.diagramNodeCursor--
		}
		return m, nil
	case "down":
		if m.diagramNodeCursor+1 < len(m.diagram.Nodes) {
			m.diagramNodeCursor++
		}
		return m, nil
	case "v":
		if len(m.diagram.Nodes) == 0 {
			return m, nil
		}
		id := m.diagram.Nodes[m.diagramNodeCursor].ID
		if id == "" {
			return m, nil
		}
		if m.diagramSelected == nil {
			m.diagramSelected = map[string]bool{}
		}
		m.diagramSelected[id] = !m.diagramSelected[id]
		return m, nil
	case "s":
		return m.beginDiagramInstruction()
	}
	return m, nil
}

func (m Model) handleDiagramInstructionKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.diagramMode = diagramModeView
		m.instructionDraft = ""
		m.status = ""
		return m, nil
	case "enter":
		m.sendbackInstruction = strings.TrimSpace(m.instructionDraft)
		m.instructionDraft = ""
		return m.finishSendback()
	case "backspace":
		if m.instructionDraft == "" {
			return m, nil
		}
		r := []rune(m.instructionDraft)
		m.instructionDraft = string(r[:len(r)-1])
		return m, nil
	default:
		if msg.Mod == 0 && msg.Text != "" {
			m.instructionDraft += msg.Text
		}
		return m, nil
	}
}

func (m Model) handleDiagramAgentPickKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.diagramMode = diagramModeView
		m.pendingSendText = ""
		m.agentPanes = nil
		m.status = ""
		return m, nil
	case "up":
		if m.agentCursor > 0 {
			m.agentCursor--
		}
		return m, nil
	case "down":
		if m.agentCursor+1 < len(m.agentPanes) {
			m.agentCursor++
		}
		return m, nil
	case "enter":
		if m.agentCursor < 0 || m.agentCursor >= len(m.agentPanes) {
			return m, nil
		}
		return m.deliverSendback(m.agentPanes[m.agentCursor].PaneID)
	}
	return m, nil
}

func (m Model) beginDiagramInstruction() (tea.Model, tea.Cmd) {
	if len(m.selectedDiagramIDs()) == 0 {
		m.status = "select steps first"
		return m, nil
	}
	m.diagramMode = diagramModeInstruction
	m.instructionDraft = ""
	m.status = ""
	return m, nil
}

func (m Model) finishSendback() (tea.Model, tea.Cmd) {
	ids := m.selectedDiagramIDs()
	if m.definition == nil {
		m.status = "send-back failed" + tui.ChromeSep + "workflow definition missing"
		m.diagramMode = diagramModeView
		return m, nil
	}
	fragments, err := workflow.StepYAMLFragments(*m.definition, ids)
	if err != nil {
		m.status = "send-back failed" + tui.ChromeSep + err.Error()
		m.diagramMode = diagramModeView
		return m, nil
	}
	bundle := FormatAnnotationBundle(m.diagramTitle, ids, fragments, m.sendbackInstruction)
	text, err := m.spillSendback(m.repoRoot, bundle)
	if err != nil {
		m.status = "send-back failed" + tui.ChromeSep + err.Error()
		m.diagramMode = diagramModeView
		return m, nil
	}
	if m.listAgentPanes == nil {
		m.status = "send-back failed" + tui.ChromeSep + "agent list not wired"
		m.diagramMode = diagramModeView
		return m, nil
	}
	panes, err := m.listAgentPanes()
	if err != nil {
		m.status = "send-back failed" + tui.ChromeSep + err.Error()
		m.diagramMode = diagramModeView
		return m, nil
	}
	if len(panes) == 0 {
		m.status = "send-back failed" + tui.ChromeSep + "no agent panes"
		m.diagramMode = diagramModeView
		return m, nil
	}
	m.pendingSendText = text
	if len(panes) == 1 {
		return m.deliverSendback(panes[0].PaneID)
	}
	m.agentPanes = panes
	m.agentCursor = 0
	m.diagramMode = diagramModeAgentPick
	m.status = ""
	return m, nil
}

func (m Model) deliverSendback(paneID string) (tea.Model, tea.Cmd) {
	if m.paneSendText == nil {
		m.status = "send-back failed" + tui.ChromeSep + "pane send not wired"
		m.diagramMode = diagramModeView
		m.resetDiagramSendback()
		return m, nil
	}
	if err := m.paneSendText(paneID, m.pendingSendText); err != nil {
		m.status = "send-back failed" + tui.ChromeSep + err.Error()
		m.diagramMode = diagramModeView
		m.resetDiagramSendback()
		return m, nil
	}
	m.status = "typed annotation" + tui.ChromeSep + paneID
	m.diagramMode = diagramModeView
	m.resetDiagramSendback()
	return m, nil
}

func (m *Model) resetDiagramSendback() {
	m.pendingSendText = ""
	m.agentPanes = nil
	m.agentCursor = 0
	m.instructionDraft = ""
	m.sendbackInstruction = ""
}

func (m Model) selectedDiagramIDs() []string {
	if len(m.diagramSelected) == 0 {
		return nil
	}
	var ids []string
	for _, node := range m.diagram.Nodes {
		if node.ID != "" && m.diagramSelected[node.ID] {
			ids = append(ids, node.ID)
		}
	}
	return ids
}

func (m Model) diagramMarks() DiagramMarks {
	return DiagramMarks{
		SelectMode: m.diagramMode == diagramModeSelect,
		FocusIndex: m.diagramNodeCursor,
		Selected:   m.diagramSelected,
	}
}

func FormatAgentPickBody(panes []AgentPaneEntry, cursor int) string {
	var lines []string
	lines = append(lines, "send-back target agent")
	for i, pane := range panes {
		prefix := "  "
		if i == cursor {
			prefix = tui.CursorPrefix
		}
		label := pane.Title
		if label == "" {
			label = pane.Name
		}
		if label == "" {
			label = pane.PaneID
		}
		lines = append(lines, prefix+label)
	}
	return strings.Join(lines, "\n")
}
