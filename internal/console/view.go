package console

import (
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/runsbrowser"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func (m Model) View() tea.View {
	v := tea.NewView(tui.PadHeight(tui.PadContent(m.render(), m.contentWidth()), m.height))
	v.MouseMode = tea.MouseModeAllMotion
	v.AltScreen = true
	return v
}

func filterRow(filter, placeholder string, width int) string {
	if filter == "" {
		return tui.Truncate(placeholder, width)
	}
	return tui.Truncate(filter, width)
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
	entries := m.visibleEntries()
	var rows []string
	end := min(m.wfOffset+vp, len(entries))
	for i := m.wfOffset; i < end; i++ {
		e := entries[i]
		rows = append(rows, tui.FormatRow(workflow.DisplayTitle(e.Name, e.Title), entryLocation(e), entrySensitive(e), w, i == m.wfCursor))
	}
	for len(rows) < vp {
		rows = append(rows, "")
	}
	detail := ""
	if m.wfCursor >= 0 && m.wfCursor < len(entries) {
		detail = tui.FormatDetailBlock(entries[m.wfCursor].Description, w)
	}
	footer := tui.FormatListFooter(w, m.wfCursor, len(entries), workflowsFooter())
	head := filterRow(m.wfFilter, tui.FilterWorkflows, w)
	return head + "\n\n" + strings.Join(rows, "\n") + "\n\n" + detail + "\n" + tui.FormatRule(w) + "\n" + footer
}

func (m Model) renderDiagram() string {
	w := m.contentWidth()
	switch m.diagramMode {
	case diagramModeInsertSide:
		return m.renderDiagramInsertSide(w)
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
	body, _ := renderRailYAML(m.diagram, m.diagramYAML, m.diagramMarks(), w, vp, m.diagramScroll)
	lines := strings.Split(body, "\n")
	for len(lines) < vp {
		lines = append(lines, "")
	}
	status := m.status
	if status == "" {
		status = diagramFooter()
	}
	footer := tui.FormatListFooter(w, 0, 0, status)
	head := tui.Truncate("diagram"+tui.ChromeSep+m.diagramTitle, w)
	return head + "\n" + strings.Join(lines, "\n") + "\n" + tui.FormatRule(w) + "\n" + footer
}

func (m Model) renderDiagramInsertSide(w int) string {
	theme := tui.DefaultTheme()
	card := m.focusedTitle()
	lines := []string{tui.Truncate("Insert a new step where?", w)}
	for _, side := range []insertSide{insertBefore, insertAfter} {
		row := tui.FormatRow(string(side)+" "+card, "", false, w, side == m.insertAt)
		if side != m.insertAt {
			row = theme.Muted.Render(row)
		}
		lines = append(lines, row)
	}
	vp := m.scrollViewport()
	for len(lines) < vp {
		lines = append(lines, "")
	}
	status := m.status
	if status == "" {
		status = insertSideFooter()
	}
	head := tui.Truncate("diagram"+tui.ChromeSep+m.diagramTitle, w)
	return head + "\n" + strings.Join(lines[:vp], "\n") + "\n" + tui.FormatRule(w) + "\n" + tui.FormatListFooter(w, 0, 0, status)
}

func (m Model) renderDiagramInstruction(w int) string {
	bundle := m.annotationBundle(m.selectedDiagramIDs())
	lines := []string{
		tui.Truncate("Tell the agent pane what to change. It edits the workflow file.", w),
		tui.MuteChrome(tui.Truncate(composerScope(bundle), w)),
		"",
	}
	lines = append(lines, wrapDraft(tui.CursorPrefix+m.instructionDraft+"_", w)...)
	vp := m.scrollViewport()
	if len(lines) > vp {
		lines = lines[len(lines)-vp:]
	}
	for len(lines) < vp {
		lines = append(lines, "")
	}
	status := m.status
	if status == "" {
		status = "enter send" + tui.ChromeSep + "esc back"
	}
	footer := tui.FormatListFooter(w, 0, 0, status)
	head := tui.Truncate("diagram"+tui.ChromeSep+m.diagramTitle, w)
	return head + "\n" + strings.Join(lines, "\n") + "\n" + tui.FormatRule(w) + "\n" + footer
}

// wrapDraft breaks typed text on the content width. A truncation would not show
// the typed text after the draft is longer than one row.
func wrapDraft(s string, width int) []string {
	if width <= 0 {
		return []string{s}
	}
	var out []string
	var line []rune
	used := 0
	for _, r := range s {
		rw := tui.Columns(string(r))
		if used+rw > width {
			out = append(out, string(line))
			line, used = nil, 0
		}
		line = append(line, r)
		used += rw
	}
	return append(out, string(line))
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
	runs := m.visibleRuns()
	var rows []string
	end := min(m.runOffset+vp, len(runs))
	titleW := max(0, w-tui.RowTextIndent-tui.RowRightGutter)
	for i := m.runOffset; i < end; i++ {
		row := runsbrowser.FormatRunRow(runs[i], titleW, runsbrowser.FormatRunRowOpts{})
		rows = append(rows, tui.FormatRow(row, "", false, w, i == m.runCursor))
	}
	for len(rows) < vp {
		rows = append(rows, "")
	}
	detail := ""
	if m.runCursor >= 0 && m.runCursor < len(runs) {
		detail = tui.FormatDetailBlock(runsbrowser.FormatRunSummary(runs[m.runCursor]), w)
	}
	footer := tui.FormatListFooter(w, m.runCursor, len(runs), runsFooter())
	head := filterRow(m.runFilter, tui.FilterRuns, w)
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
	return strings.Join([]string{"tab", "enter diagram", "esc"}, tui.ChromeSep)
}

func runsFooter() string {
	return strings.Join([]string{"tab", "enter detail", "esc"}, tui.ChromeSep)
}

func detailFooter() string {
	return strings.Join([]string{"1/2/3 tabs", "y retry-copy", "esc back"}, tui.ChromeSep)
}

func (m Model) detailScrollLines() []string {
	w := m.contentWidth()
	body := FormatDebugBody(m.debugTab, debugContentOf(m.detail))
	return asciiLines(body, w)
}

func diagramFooter() string {
	return strings.Join([]string{"a insert", "d delete", "v toggle", "s send-back", "pgup/pgdn yaml", "esc back"}, tui.ChromeSep)
}

func insertSideFooter() string {
	return strings.Join([]string{"up/down pick", "b before", "a after", "enter confirm", "esc back"}, tui.ChromeSep)
}
