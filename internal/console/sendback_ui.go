package console

import (
	"os"
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

// noStepIDStatus explains a mark slot that the console cannot fill. Selection
// uses a declared id, and a positional title cannot name a step.
const noStepIDStatus = "step declares no id" + tui.ChromeSep + "add id: to select it"

// agentSelfMarker names the caller's own pane. Sending back to yourself is the
// mistake it prevents.
const agentSelfMarker = "(you)"

type diagramMode int

const (
	diagramModeView diagramMode = iota
	diagramModeInsertSide
	diagramModeInstruction
	diagramModeAgentPick
)

// insertSide names the side of the focused card for a new step. The rail
// has no gap cursor, so `a` asks.
type insertSide string

const (
	insertBefore insertSide = "before"
	insertAfter  insertSide = "after"
)

// AgentPaneEntry is one selectable agent pane for send-back.
type AgentPaneEntry struct {
	PaneID string
	Tab    string
	Kind   string
	Status string
	Title  string
	Self   bool
}

func AgentPaneEntriesFromHost(panes []host.AgentPane) []AgentPaneEntry {
	out := make([]AgentPaneEntry, len(panes))
	for i, pane := range panes {
		out[i] = AgentPaneEntry{
			PaneID: pane.PaneID,
			Tab:    pane.Tab,
			Kind:   pane.Kind,
			Status: pane.Status,
			Title:  pane.Title,
			Self:   pane.Self,
		}
	}
	return out
}

func (m Model) handleDiagramKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch m.diagramMode {
	case diagramModeInsertSide:
		return m.handleDiagramInsertSideKey(msg)
	case diagramModeInstruction:
		return m.handleDiagramInstructionKey(msg)
	case diagramModeAgentPick:
		return m.handleDiagramAgentPickKey(msg)
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
		return m.moveDiagramFocus(-1)
	case "down":
		return m.moveDiagramFocus(1)
	case "pgup":
		m.scrollDiagramYAML(-1)
		return m, nil
	case "pgdown":
		m.scrollDiagramYAML(1)
		return m, nil
	case "v":
		m.toggleFocusedCard()
		return m, nil
	case "a":
		return m.seedInsertInstruction()
	case "d":
		return m.seedDeleteInstruction()
	case "s":
		return m.beginDiagramInstruction("")
	}
	return m, nil
}

func (m Model) moveDiagramFocus(delta int) (tea.Model, tea.Cmd) {
	m.diagramFocus = moveRailFocus(m.diagramFocus, len(m.diagram.Nodes), delta)
	m.status = ""
	m.diagramYAMLScroll = 0
	m.diagramScroll = railScrollIntoView(m.diagram, m.diagramMarks(), m.contentWidth(), m.scrollViewport(), m.diagramScroll)
	return m, nil
}

func (m *Model) toggleFocusedCard() {
	if m.diagramFocus.Index < 0 || m.diagramFocus.Index >= len(m.diagram.Nodes) {
		return
	}
	id := m.diagram.Nodes[m.diagramFocus.Index].ID
	if id == "" {
		m.status = noStepIDStatus
		return
	}
	if m.diagramSelected == nil {
		m.diagramSelected = map[string]bool{}
	}
	m.diagramSelected[id] = !m.diagramSelected[id]
}

// seedInsertInstruction asks which side of the focused card gets the new step
// before it opens the composer. An empty diagram has no side to pick.
func (m Model) seedInsertInstruction() (tea.Model, tea.Cmd) {
	if len(m.diagram.Nodes) == 0 {
		m.insertAt = ""
		return m.beginDiagramInstruction(insertSeed("", ""))
	}
	m.diagramMode = diagramModeInsertSide
	m.insertAt = insertAfter
	m.status = ""
	return m, nil
}

func (m Model) handleDiagramInsertSideKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.diagramMode = diagramModeView
		m.insertAt = ""
		return m, nil
	case "up", "left":
		m.insertAt = insertBefore
		return m, nil
	case "down", "right":
		m.insertAt = insertAfter
		return m, nil
	case "b":
		m.insertAt = insertBefore
	case "a":
		m.insertAt = insertAfter
	case "enter":
	default:
		return m, nil
	}
	return m.beginDiagramInstruction(insertSeed(m.focusedTitle(), m.insertAt))
}

// focusedTitle names the focused step the same way its card does. A seeded
// instruction can still name a step that declares no id.
func (m Model) focusedTitle() string {
	if m.diagramFocus.Index < 0 || m.diagramFocus.Index >= len(m.diagram.Nodes) {
		return ""
	}
	title, _ := railTitle(m.diagram.Nodes[m.diagramFocus.Index])
	return title
}

func (m Model) seedDeleteInstruction() (tea.Model, tea.Cmd) {
	if len(m.diagram.Nodes) == 0 {
		m.status = "d needs a card"
		return m, nil
	}
	return m.beginDiagramInstruction(deleteSeed(m.focusedTitle()))
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
		m.instructionDraft = tui.TrimLastRune(m.instructionDraft)
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
		m.status = ""
		m.abandonSendback()
		return m, nil
	case "up":
		if m.agentCursor > 0 {
			m.agentCursor--
		}
		m.clampAgentWindow()
		return m, nil
	case "down":
		if m.agentCursor+1 < len(m.agentPanes) {
			m.agentCursor++
		}
		m.clampAgentWindow()
		return m, nil
	case "enter":
		if m.agentCursor < 0 || m.agentCursor >= len(m.agentPanes) {
			return m, nil
		}
		return m.deliverSendback(m.agentPanes[m.agentCursor].PaneID)
	}
	return m, nil
}

func (m Model) beginDiagramInstruction(seed string) (tea.Model, tea.Cmd) {
	m.diagramMode = diagramModeInstruction
	m.instructionDraft = seed
	m.status = ""
	return m, nil
}

func (m Model) finishSendback() (tea.Model, tea.Cmd) {
	ids := m.selectedDiagramIDs()
	bundle := FormatAnnotationBundle(m.annotationBundle(ids))
	text, spillPath, err := m.spillSendback(m.repoRoot, bundle)
	if err != nil {
		m.status = "send-back failed" + tui.ChromeSep + err.Error()
		m.diagramMode = diagramModeView
		return m, nil
	}
	m.pendingSpillPath = spillPath
	if m.listAgentPanes == nil {
		m.status = "send-back failed" + tui.ChromeSep + "agent list not wired"
		m.diagramMode = diagramModeView
		m.abandonSendback()
		return m, nil
	}
	panes, err := m.listAgentPanes()
	if err != nil {
		m.status = "send-back failed" + tui.ChromeSep + err.Error()
		m.diagramMode = diagramModeView
		m.abandonSendback()
		return m, nil
	}
	if len(panes) == 0 {
		m.status = "send-back failed" + tui.ChromeSep + "no agent panes"
		m.diagramMode = diagramModeView
		m.abandonSendback()
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
		m.abandonSendback()
		return m, nil
	}
	if err := m.paneSendText(paneID, m.pendingSendText); err != nil {
		m.status = "send-back failed" + tui.ChromeSep + err.Error()
		m.diagramMode = diagramModeView
		m.abandonSendback()
		return m, nil
	}
	m.status = "typed annotation" + tui.ChromeSep + paneID
	m.diagramMode = diagramModeView
	m.resetDiagramSendback()
	return m, nil
}

// abandonSendback removes an undelivered spill file.
func (m *Model) abandonSendback() {
	if m.pendingSpillPath != "" {
		_ = os.Remove(m.pendingSpillPath)
	}
	m.resetDiagramSendback()
}

func (m *Model) resetDiagramSendback() {
	m.insertAt = ""
	m.pendingSendText = ""
	m.pendingSpillPath = ""
	m.agentPanes = nil
	m.agentCursor = 0
	m.agentOffset = 0
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

func (m Model) annotationBundle(ids []string) AnnotationBundle {
	b := AnnotationBundle{
		Title:       m.diagramTitle,
		File:        m.diagramFile,
		Focus:       ids,
		AnchorKind:  "workflow",
		Instruction: m.sendbackInstruction,
	}
	if m.diagramFocus.Index < 0 || m.diagramFocus.Index >= len(m.diagram.Nodes) {
		return b
	}
	id := m.diagram.Nodes[m.diagramFocus.Index].ID
	if id == "" {
		return b
	}
	b.AnchorID = id
	b.AnchorKind = "step"
	if m.insertAt != "" {
		b.AnchorKind = string(m.insertAt)
	}
	return b
}

func (m Model) diagramMarks() DiagramMarks {
	return DiagramMarks{
		Focus:      m.diagramFocus,
		Selected:   m.diagramSelected,
		YAMLScroll: m.diagramYAMLScroll,
	}
}

// FormatAgentPickBody lists agent panes as tab, status, title, and a self marker.
// Only the title truncates, because it is the part worth reading.
func FormatAgentPickBody(panes []AgentPaneEntry, cursor, width int) string {
	lines := []string{"send-back target agent"}
	tabW := 0
	for _, pane := range panes {
		tabW = max(tabW, tui.Columns(agentPaneTab(pane)))
	}
	for i, pane := range panes {
		prefix := "  "
		if i == cursor {
			prefix = tui.CursorPrefix
		}
		left := prefix + tui.PadColumns(agentPaneTab(pane), tabW) + " " + AgentStatusGlyph(pane.Status) + " "
		marker := ""
		if pane.Self {
			marker = " " + agentSelfMarker
		}
		titleW := max(1, width-tui.Columns(left)-tui.Columns(marker))
		title := tui.PadColumns(tui.Truncate(agentPaneTitle(pane), titleW), titleW)
		lines = append(lines, strings.TrimRight(left+title+marker, " "))
	}
	return strings.Join(lines, "\n")
}

// AgentStatusGlyph is the one-column status token. The chooser footer legend
// names the three that a reader acts on.
func AgentStatusGlyph(status string) string {
	switch status {
	case "working":
		return "*"
	case "idle", "done":
		return "-"
	case "blocked":
		return "!"
	default:
		return "?"
	}
}

func agentPaneTab(pane AgentPaneEntry) string {
	if pane.Tab != "" {
		return pane.Tab
	}
	return "?"
}

func agentPaneTitle(pane AgentPaneEntry) string {
	if pane.Title != "" {
		return pane.Title
	}
	return pane.PaneID
}
