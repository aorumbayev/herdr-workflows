package runsbrowser

import (
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

func (m Model) View() tea.View {
	return tea.NewView(tui.PadHeight(tui.PadContent(m.render(), m.contentWidth()), m.height))
}

// Body returns unpadded list or detail text for embedding in the picker.
func (m Model) Body() string {
	return m.render()
}

func (m Model) render() string {
	var body string
	if m.screen == screenDetail {
		body = m.renderDetail()
	} else {
		body = m.renderList()
	}
	return body
}

func (m Model) contentWidth() int {
	return tui.ContentWidth(m.width)
}

func (m Model) renderList() string {
	w := m.contentWidth()
	filter := m.listFilterRow(w)
	if m.state.Unavailable || len(m.state.Items) == 0 {
		empty := FormatRunListEmpty(RunListEmptyOpts{
			Scope:          m.scope,
			HasMachineRuns: m.state.HasMachineRuns,
			FilterActive:   strings.TrimSpace(m.filter) != "",
			Unavailable:    m.state.Unavailable,
		})
		body := filter + "\n\n" + tui.FormatDetailBlock(empty, w) + "\n" + tui.FormatRule(w) + "\n" + tui.FormatListFooter(w, 0, 0, RunsFooter(m.scope, 0, 0))
		return body
	}
	end := min(m.offset+ListViewport, len(m.state.Items))
	var rows []string
	showLocation := m.scope == ScopeAll
	titleW := max(0, w-tui.RowTextIndent-tui.RowRightGutter)
	for i := m.offset; i < end; i++ {
		item := m.state.Items[i]
		row := FormatRunRow(item, titleW, FormatRunRowOpts{ShowLocation: showLocation})
		rows = append(rows, tui.FormatRow(row, "", false, w, i == m.cursor))
	}
	for len(rows) < ListViewport {
		rows = append(rows, "")
	}
	detail := ""
	if item := m.selectedItem(); item != nil {
		detail = tui.FormatDetailBlock(FormatRunSummary(*item), w)
	}
	footer := tui.FormatListFooter(w, m.cursor, len(m.state.Items), RunsFooter(m.scope, m.cursor, len(m.state.Items)))
	return filter + "\n\n" + strings.Join(rows, "\n") + "\n\n" + detail + "\n" + tui.FormatRule(w) + "\n" + footer
}

func (m Model) listFilterRow(width int) string {
	label := m.filter
	if label == "" {
		label = tui.FilterRuns
	}
	return tui.Truncate(label, width)
}

func (m Model) renderDetail() string {
	w := m.contentWidth()
	lines := DetailLines(m.detailView, w)
	visible, _ := ScrollDetailLines(lines, m.detailScroll, detailViewport)
	for len(visible) < detailViewport {
		visible = append(visible, "")
	}
	footer := tui.FormatListFooter(w, 0, 0, RunDetailFooter())
	return strings.Join(visible, "\n") + "\n" + tui.FormatRule(w) + "\n" + footer
}
