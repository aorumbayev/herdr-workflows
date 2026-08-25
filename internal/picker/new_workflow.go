package picker

import (
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/console"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

var newModeOptions = []string{"build with an agent", "edit a template"}

var newScopeOptions = []string{"repo (.hwf/workflows)", "global"}

func formatChooserBody(title string, options []string, cursor int) string {
	lines := []string{title}
	for i, opt := range options {
		prefix := "  "
		if i == cursor {
			prefix = tui.CursorPrefix
		}
		lines = append(lines, prefix+opt)
	}
	return strings.Join(lines, "\n")
}

func (m Model) handleNewMode(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.mode = modeList
		m.filter = m.savedFilter
		m.status = ""
		return m, nil
	case "up":
		if m.newModeCursor > 0 {
			m.newModeCursor--
		}
		return m, nil
	case "down":
		if m.newModeCursor+1 < len(newModeOptions) {
			m.newModeCursor++
		}
		return m, nil
	case "enter":
		if m.newModeCursor == 0 {
			return m.beginNewAgent()
		}
		m.mode = modeNewName
		m.promptValue = ""
		m.status = ""
		return m, nil
	}
	return m, nil
}

func (m Model) handleNewScope(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.mode = modeNewName
		m.status = ""
		return m, nil
	case "up":
		if m.newScopeCursor > 0 {
			m.newScopeCursor--
		}
		return m, nil
	case "down":
		if m.newScopeCursor+1 < len(newScopeOptions) {
			m.newScopeCursor++
		}
		return m, nil
	case "enter":
		return m.createTemplate()
	}
	return m, nil
}

func (m Model) createTemplate() (tea.Model, tea.Cmd) {
	source := "repo"
	path, err := workflow.CreateRepoWorkflow(m.repoRoot, m.newName)
	if m.newScopeCursor == 1 {
		source = "global"
		path, err = workflow.CreateGlobalWorkflow(m.newName)
	}
	if err != nil {
		m.status = err.Error()
		m.mode = modeList
		return m, nil
	}
	entry := workflow.ListEntry{Name: m.newName, Source: source, File: path, RepoOwned: source == "repo"}
	m.entries = append(m.entries, entry)
	m.promptValue = ""
	return m.beginEditPlacement(&entry)
}

func (m Model) beginNewAgent() (tea.Model, tea.Cmd) {
	if m.listAgentPanes == nil {
		m.status = "no agent panes open — open an agent in herdr first"
		return m, nil
	}
	panes, err := m.listAgentPanes()
	if err != nil || len(panes) == 0 {
		m.status = "no agent panes open — open an agent in herdr first"
		return m, nil
	}
	m.pendingSendText = workflowCreateHandoffPrompt()
	if len(panes) == 1 {
		return m.deliverNewAgentHandoff(panes[0].PaneID)
	}
	m.agentPanes = panes
	m.agentCursor = 0
	m.mode = modeNewAgentPick
	return m, nil
}

func (m Model) handleNewAgentPick(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.mode = modeNewMode
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
		return m.deliverNewAgentHandoff(m.agentPanes[m.agentCursor].PaneID)
	}
	return m, nil
}

func (m Model) deliverNewAgentHandoff(paneID string) (tea.Model, tea.Cmd) {
	text := m.pendingSendText
	m.pendingSendText = ""
	m.agentPanes = nil
	if m.paneSendText == nil {
		m.mode = modeList
		m.status = "handoff failed" + tui.ChromeSep + "send not wired"
		return m, nil
	}
	if err := m.paneSendText(paneID, text); err != nil {
		m.mode = modeList
		m.status = "handoff failed" + tui.ChromeSep + err.Error()
		if m.notify != nil {
			_ = m.notify("herdr-workflows", m.status)
		}
		return m, nil
	}
	if m.notify != nil {
		_ = m.notify("herdr-workflows", "typed workflow-create handoff")
	}
	m.quit = true
	return m, tea.Quit
}

// workflowCreateHandoffPrompt is typed into the chosen agent pane, not submitted.
func workflowCreateHandoffPrompt() string {
	return strings.Join([]string{
		"Help me author a new herdr workflow.",
		"First run `hwf skills show herdr-workflow-create` and follow that skill.",
		"Before you write any YAML, grill me about what the workflow should do: its goal, the steps it runs, and the inputs it needs.",
		"Then build the workflow and save it at the level I choose — repo (.hwf/workflows) or global — ask me which.",
		"Validate the file with `hwf workflow validate <file>` before you finish.",
	}, "\n")
}

func (m Model) renderNewMode() string {
	w := m.contentWidth()
	body := formatChooserBody("new workflow", newModeOptions, m.newModeCursor)
	footer := tui.FormatListFooter(w, m.newModeCursor, len(newModeOptions), "enter select"+tui.ChromeSep+"esc back")
	return body + "\n" + tui.FormatRule(w) + "\n" + footer
}

func (m Model) renderNewScope() string {
	w := m.contentWidth()
	body := formatChooserBody("save workflow at", newScopeOptions, m.newScopeCursor)
	footer := tui.FormatListFooter(w, m.newScopeCursor, len(newScopeOptions), "enter select"+tui.ChromeSep+"esc back")
	return body + "\n" + tui.FormatRule(w) + "\n" + footer
}

func (m Model) renderNewAgentPick() string {
	w := m.contentWidth()
	body := console.FormatAgentPickBody(m.agentPanes, m.agentCursor)
	footer := tui.FormatListFooter(w, m.agentCursor, len(m.agentPanes), "enter select"+tui.ChromeSep+"esc back")
	return body + "\n" + tui.FormatRule(w) + "\n" + footer
}
