package picker

import (
	"strconv"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/console"
	"github.com/aorumbayev/herdr-workflows/internal/runsbrowser"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

// runsSendbackStatus sends a notification. The runs tab shows the browser body
// where the picker status row would be.
func (m *Model) runsSendbackStatus(text string) {
	m.status = text
	if m.notify != nil {
		_ = m.notify("herdr-workflows", text)
	}
}

func (m Model) beginRunsSendback() (tea.Model, tea.Cmd) {
	detail, step, source, ok := m.runs.FocusedFailure()
	if !ok {
		m.runsSendbackStatus("send-back needs a failed step")
		return m, nil
	}
	exit := ""
	if step.Failure != nil && step.Failure.ExitCode != nil {
		exit = strconv.Itoa(*step.Failure.ExitCode)
	}
	id := step.StepID
	if id == "" {
		id = step.Label
	}
	title := detail.Title
	if title == "" {
		title = detail.Workflow
	}
	text, _, err := console.MaybeSpillSendbackText(m.repoRoot, console.FormatAnnotationBundle(console.AnnotationBundle{
		Title:       title,
		Focus:       []string{id},
		AnchorKind:  "step",
		AnchorID:    id,
		Instruction: "Fix this failed workflow step.",
		Failure: &console.FailureBlock{
			Run:      detail.DisplayID,
			Checkout: detail.CheckoutRoot,
			Step:     id,
			Cause:    runsbrowser.StepCause(step),
			ExitCode: exit,
			Source:   source,
		},
	}))
	if err != nil {
		m.runsSendbackStatus("send-back failed" + tui.ChromeSep + err.Error())
		return m, nil
	}
	if m.listAgentPanes == nil {
		m.runsSendbackStatus("send-back failed" + tui.ChromeSep + "agent list not wired")
		return m, nil
	}
	panes, err := m.listAgentPanes()
	if err != nil {
		m.runsSendbackStatus("send-back failed" + tui.ChromeSep + err.Error())
		return m, nil
	}
	if len(panes) == 0 {
		m.runsSendbackStatus("send-back failed" + tui.ChromeSep + "no agent pane")
		return m, nil
	}
	m.pendingSendText = text
	if len(panes) == 1 {
		return m.deliverRunsSendback(panes[0].PaneID)
	}
	m.agentPanes = panes
	m.agentCursor = 0
	m.mode = modeRunsAgentPick
	return m, nil
}

func (m Model) handleRunsAgentPick(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.mode = modeRuns
		m.pendingSendText = ""
		m.agentPanes = nil
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
		return m.deliverRunsSendback(m.agentPanes[m.agentCursor].PaneID)
	}
	return m, nil
}

func (m Model) deliverRunsSendback(paneID string) (tea.Model, tea.Cmd) {
	text := m.pendingSendText
	m.pendingSendText = ""
	m.agentPanes = nil
	m.mode = modeRuns
	if m.paneSendText == nil {
		m.runsSendbackStatus("send-back failed" + tui.ChromeSep + "send not wired")
		return m, nil
	}
	if err := m.paneSendText(paneID, text); err != nil {
		m.runsSendbackStatus("send-back failed" + tui.ChromeSep + err.Error())
		return m, nil
	}
	m.runsSendbackStatus("typed annotation")
	return m, nil
}

func (m Model) renderRunsAgentPick() string {
	w := m.contentWidth()
	body := console.FormatAgentPickBody(m.agentPanes, m.agentCursor)
	footer := tui.FormatListFooter(w, m.agentCursor, len(m.agentPanes), "enter send"+tui.ChromeSep+"esc back")
	return body + "\n" + tui.FormatRule(w) + "\n" + footer
}
