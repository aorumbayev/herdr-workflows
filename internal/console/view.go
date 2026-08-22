package console

import (
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/runsbrowser"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

func (m Model) View() tea.View {
	return tea.NewView(tui.PadHeight(m.render(), m.height))
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
		rows = append(rows, FormatWorkflowRow(workflowEntry{
			Name: e.Name, Title: e.Title, Source: e.Source, Error: e.Error,
		}, w, i == m.wfCursor))
	}
	for len(rows) < vp {
		rows = append(rows, "")
	}
	detail := ""
	if len(m.entries) > 0 && m.wfCursor < len(m.entries) {
		detail = tui.FormatDetailLines(m.entries[m.wfCursor].Description, w)
	}
	footer := tui.FormatListFooter(w, m.wfCursor, len(m.entries), workflowsFooter())
	head := tui.Truncate("workflows", w)
	return head + "\n" + strings.Join(rows, "\n") + "\n" + detail + "\n" + tui.FormatRule(w) + "\n" + footer
}

func (m Model) renderDiagram() string {
	w := m.contentWidth()
	vp := max(3, m.listViewport())
	body := FormatDiagram(m.diagram, w)
	lines := asciiLines(body, w)
	visible, _ := runsbrowser.ScrollDetailLines(lines, m.diagramScroll, vp)
	for len(visible) < vp {
		visible = append(visible, "")
	}
	status := m.status
	if status == "" {
		status = diagramFooter()
	}
	footer := tui.FormatListFooter(w, 0, 0, status)
	head := tui.Truncate("diagram"+tui.ChromeSep+m.diagramTitle, w)
	return head + "\n" + strings.Join(visible, "\n") + "\n" + tui.FormatRule(w) + "\n" + footer
}

func (m Model) renderRuns() string {
	w := m.contentWidth()
	vp := m.listViewport()
	var rows []string
	end := min(m.runOffset+vp, len(m.runs))
	for i := m.runOffset; i < end; i++ {
		item := m.runs[i]
		row := runsbrowser.FormatRunRow(item, w-tui.RowTextIndent, runsbrowser.FormatRunRowOpts{})
		prefix := "  "
		if i == m.runCursor {
			prefix = tui.CursorPrefix
		}
		rows = append(rows, prefix+row)
	}
	for len(rows) < vp {
		rows = append(rows, "")
	}
	footer := tui.FormatListFooter(w, m.runCursor, len(m.runs), runsFooter())
	head := tui.Truncate("runs", w)
	return head + "\n" + strings.Join(rows, "\n") + "\n" + tui.FormatRule(w) + "\n" + footer
}

func (m Model) renderDetail() string {
	w := m.contentWidth()
	vp := max(3, m.listViewport())
	chrome := FormatDebugTabChrome(m.debugTab)
	body := FormatDebugBody(m.debugTab, debugContentOf(m.detail))
	lines := asciiLines(body, w)
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

func diagramFooter() string {
	return strings.Join([]string{"esc back"}, tui.ChromeSep)
}
