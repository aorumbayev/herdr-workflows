package console

import (
	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/runsbrowser"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

func (m Model) handleMouse(msg tea.Msg) (tea.Model, tea.Cmd) {
	if m.screen != screenDiagram || m.diagramMode == diagramModeInstruction || m.diagramMode == diagramModeAgentPick {
		return m, nil
	}
	switch msg := msg.(type) {
	case tea.MouseClickMsg:
		return m.handleDiagramClick(msg)
	case tea.MouseWheelMsg:
		return m.handleDiagramWheel(msg)
	default:
		return m, nil
	}
}

func (m Model) handleDiagramClick(msg tea.MouseClickMsg) (tea.Model, tea.Cmd) {
	if msg.Button != tea.MouseLeft {
		return m, nil
	}
	x, y := diagramMouseXY(msg.X, msg.Y)
	_, hits := renderRailYAML(m.diagram, m.diagramYAML, m.diagramMarks(), m.contentWidth(), m.scrollViewport(), m.diagramScroll)
	hit, ok := hitAt(hits, x, y)
	if !ok {
		return m, nil
	}
	m.diagramFocus = railFocus{Index: hit.Index}
	m.diagramYAMLScroll = 0
	if msg.Mod&tea.ModCtrl == 0 {
		return m, nil
	}
	if hit.Step == "" {
		m.status = noStepIDStatus
		return m, nil
	}
	if m.diagramSelected == nil {
		m.diagramSelected = map[string]bool{}
	}
	m.diagramSelected[hit.Step] = !m.diagramSelected[hit.Step]
	return m, nil
}

func (m Model) handleDiagramWheel(msg tea.MouseWheelMsg) (tea.Model, tea.Cmd) {
	delta := 0
	switch msg.Button {
	case tea.MouseWheelUp:
		delta = -1
	case tea.MouseWheelDown:
		delta = 1
	}
	if delta == 0 {
		return m, nil
	}
	x, _ := diagramMouseXY(msg.X, msg.Y)
	if leftW, _ := tui.RailSplit(m.contentWidth()); x >= leftW {
		m.scrollDiagramYAML(delta)
		return m, nil
	}
	m.diagramScroll = clampRailScroll(m.diagramScroll+delta, len(m.diagram.Nodes))
	return m, nil
}

func clampRailScroll(scroll, nodes int) int {
	return min(max(scroll, 0), maxRailScroll(nodes))
}

func (m *Model) scrollDiagramYAML(delta int) {
	m.diagramYAMLScroll += delta
	m.clampYAMLScroll()
}

func (m *Model) clampYAMLScroll() {
	_, rightW := tui.RailSplit(m.contentWidth())
	lines := railYAMLLines(m.diagram, m.diagramYAML, m.diagramFocus, rightW)
	m.diagramYAMLScroll = runsbrowser.ClampDetailScroll(lines, m.diagramYAMLScroll, m.scrollViewport())
}

func diagramMouseXY(x, y int) (int, int) {
	x -= tui.ChromePaddingX
	if x < 0 {
		x = 0
	}
	y--
	if y < 0 {
		y = 0
	}
	return x, y
}

func (m Model) ApplyMouse(msg tea.Msg) (Model, tea.Cmd) {
	next, cmd := m.handleMouse(msg)
	return next.(Model), cmd
}
