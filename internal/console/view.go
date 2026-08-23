package console

import (
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/runsbrowser"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

func (m Model) View() tea.View {
	return tea.NewView(tui.PadHeight(tui.PadContent(m.render(), m.contentWidth()), m.height))
}

func (m Model) render() string {
	switch m.screen {
	case screenDetail:
		return m.renderDetail()
	case screenRuns:
		return m.renderRuns()
	case screenDiagram:
		return m.renderDiagram()
	default:
		return m.renderWorkflows()
	}
}

func (m Model) renderWorkflows() string {
	w := m.contentWidth()
	vp := m.listViewport()
	var rows []string
	end := min(m.wfOffset+vp, len(m.entries))
	for i := m.wfOffset; i < end; i++ {
		e := m.entries[i]
		title := e.Title
		if title == "" {
			title = e.Name
		}
		loc := e.Source
		if e.Error != "" {
			loc = "invalid"
		}
		rows = append(rows, tui.FormatRow(title, loc, false, w, i == m.wfCursor))
	}
	for len(rows) < vp {
		rows = append(rows, "")
	}
	detail := ""
	if len(m.entries) > 0 && m.wfCursor < len(m.entries) {
		detail = tui.FormatDetailBlock(m.entries[m.wfCursor].Description, w)
	}
	footer := tui.FormatListFooter(w, m.wfCursor, len(m.entries), workflowsFooter())
	head := tui.Truncate("workflows", w)
	return head + "\n\n" + strings.Join(rows, "\n") + "\n\n" + detail + "\n" + tui.FormatRule(w) + "\n" + footer
}

func (m Model) renderDiagram() string {
	w := m.contentWidth()
	switch m.diagramMode {
	case diagramModeInstruction:
		return m.renderDiagramInstruction(w)
	case diagramModeAgentPick:
		return m.renderDiagramAgentPick(w)
	default:
		return m.renderDiagramBody(w)
	}
}

func (m Model) renderDiagramBody(w int) string {
	vp := m.scrollViewport()
	lines := m.diagramScrollLines(w)
	visible, _ := runsbrowser.ScrollDetailLines(lines, m.diagramScroll, vp)
	for len(visible) < vp {
		visible = append(visible, "")
	}
	status := m.status
	if status == "" {
		status = diagramFooter(m.diagramMode)
	}
	footer := tui.FormatListFooter(w, 0, 0, status)
	head := tui.Truncate("diagram"+tui.ChromeSep+m.diagramTitle, w)
	return head + "\n" + strings.Join(visible, "\n") + "\n" + tui.FormatRule(w) + "\n" + footer
}

func (m Model) renderDiagramInstruction(w int) string {
	body := "send-back instruction\n> " + m.instructionDraft
	status := m.status
	if status == "" {
		status = "enter send" + tui.ChromeSep + "esc back"
	}
	footer := tui.FormatListFooter(w, 0, 0, status)
	head := tui.Truncate("diagram"+tui.ChromeSep+m.diagramTitle, w)
	return head + "\n" + tui.Truncate(body, w) + "\n" + tui.FormatRule(w) + "\n" + footer
}

func (m Model) renderDiagramAgentPick(w int) string {
	vp := m.scrollViewport()
	body := FormatAgentPickBody(m.agentPanes, m.agentCursor)
	lines := strings.Split(body, "\n")
	header, items := lines[0], lines[1:]
	itemVP := vp - 1
	offset := min(m.agentOffset, max(0, len(items)-itemVP))
	items = items[offset:min(offset+itemVP, len(items))]
	lines = append([]string{header}, items...)
	for len(lines) < vp {
		lines = append(lines, "")
	}
	status := m.status
	if status == "" {
		status = "enter send" + tui.ChromeSep + "esc back"
	}
	footer := tui.FormatListFooter(w, m.agentCursor, len(m.agentPanes), status)
	head := tui.Truncate("diagram"+tui.ChromeSep+m.diagramTitle, w)
	return head + "\n" + strings.Join(lines, "\n") + "\n" + tui.FormatRule(w) + "\n" + footer
}

func (m Model) renderRuns() string {
	w := m.contentWidth()
	vp := m.listViewport()
	var rows []string
	end := min(m.runOffset+vp, len(m.runs))
	titleW := max(0, w-tui.RowTextIndent-tui.RowRightGutter)
	for i := m.runOffset; i < end; i++ {
		item := m.runs[i]
		row := runsbrowser.FormatRunRow(item, titleW, runsbrowser.FormatRunRowOpts{})
		rows = append(rows, tui.FormatRow(row, "", false, w, i == m.runCursor))
	}
	for len(rows) < vp {
		rows = append(rows, "")
	}
	detail := ""
	if len(m.runs) > 0 && m.runCursor < len(m.runs) {
		detail = tui.FormatDetailBlock(runsbrowser.FormatRunSummary(m.runs[m.runCursor]), w)
	}
	footer := tui.FormatListFooter(w, m.runCursor, len(m.runs), runsFooter())
	head := tui.Truncate("runs", w)
	return head + "\n\n" + strings.Join(rows, "\n") + "\n\n" + detail + "\n" + tui.FormatRule(w) + "\n" + footer
}

func (m Model) renderDetail() string {
	w := m.contentWidth()
	vp := m.scrollViewport()
	chrome := FormatDebugTabChrome(m.debugTab)
	lines := m.detailScrollLines()
	visible, _ := runsbrowser.ScrollDetailLines(lines, m.detailScroll, vp)
	for len(visible) < vp {
		visible = append(visible, "")
	}
	status := m.status
	if status == "" {
		status = detailFooter()
	}
	footer := tui.FormatListFooter(w, 0, 0, status)
	return chrome + "\n" + strings.Join(visible, "\n") + "\n" + tui.FormatRule(w) + "\n" + footer
}

func workflowsFooter() string {
	return strings.Join([]string{"enter diagram", "tab runs", "esc quit"}, tui.ChromeSep)
}

func runsFooter() string {
	return strings.Join([]string{"tab workflows", "enter detail", "esc quit"}, tui.ChromeSep)
}

func detailFooter() string {
	return strings.Join([]string{"1/2/3 tabs", "y retry-copy", "esc back"}, tui.ChromeSep)
}

func (m Model) detailScrollLines() []string {
	w := m.contentWidth()
	body := FormatDebugBody(m.debugTab, debugContentOf(m.detail))
	return asciiLines(body, w)
}

func (m Model) diagramScrollLines(w int) []string {
	return asciiLines(FormatDiagramWithMarks(m.diagram, m.diagramMarks(), w), w)
}

func diagramFooter(mode diagramMode) string {
	switch mode {
	case diagramModeSelect:
		return strings.Join([]string{"v toggle", "s send-back", "esc back"}, tui.ChromeSep)
	default:
		return strings.Join([]string{"v select", "s send-back", "esc back"}, tui.ChromeSep)
	}
}
