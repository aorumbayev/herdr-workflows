package runsbrowser

import (
	"strings"

	"charm.land/lipgloss/v2"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

func (m Model) View() tea.View {
	return tea.NewView(tui.PadHeight(tui.PadContent(m.render(), m.contentWidth()), m.height))
}

// Body gives unpadded list or detail text for the picker.
func (m Model) Body() string {
	return m.render()
}

func (m Model) render() string {
	if m.screen == screenDetail {
		m.detailView = m.liveDetailView()
		return m.renderDetail()
	}
	return m.renderList()
}

// liveDetailView recomputes elapsed for a non-terminal run so the open detail ticks.
func (m Model) liveDetailView() DetailView {
	view := m.detailView
	if !liveDetailTicks(view) {
		return view
	}
	d := view.Detail
	d.ElapsedMs = history.LiveDetailElapsedMs(d, m.clock())
	view.Detail = d
	view.Blocks = history.PresentRunDetail(d)
	return view
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
		return filter + "\n\n" + tui.FormatDetailBlock(empty, w) + "\n" + tui.FormatRule(w) + "\n" + tui.MuteChrome(tui.FormatListFooter(w, 0, 0, RunsFooter(m.scope)))
	}
	vp := m.listViewport()
	end := min(m.offset+vp, len(m.state.Items))
	var rows []string
	showLocation := m.scope == ScopeAll
	titleW := max(0, w-tui.RowTextIndent-tui.RowRightGutter)
	for i := m.offset; i < end; i++ {
		item := m.state.Items[i]
		item.ElapsedMs = history.LiveElapsedMs(item, m.clock())
		row := FormatRunRow(item, titleW, FormatRunRowOpts{ShowLocation: showLocation})
		plain := tui.FormatRow(row, "", false, w, i == m.cursor)
		rows = append(rows, paintStatus(plain, rowStatusToken(item, titleW), item.Status, i == m.cursor))
	}
	for len(rows) < vp {
		rows = append(rows, "")
	}
	detail := ""
	if item := m.selectedItem(); item != nil {
		detail = tui.FormatDetailBlock(FormatRunSummary(*item), w)
	}
	footer := tui.MuteChrome(tui.FormatListFooter(w, m.cursor, len(m.state.Items), RunsFooter(m.scope)))
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
	if m.detailView.Kind == "" || m.detailView.Kind == "detail" {
		if stepCount(m.detailView.Detail) > 0 {
			return m.renderRailDetail()
		}
	}
	w := m.contentWidth()
	lines := DetailLines(m.detailView, w)
	rows := m.detailRows()
	visible, _ := ScrollDetailLines(lines, m.detailScroll, rows)
	for len(visible) < rows {
		visible = append(visible, "")
	}
	footer := tui.FormatListFooter(w, 0, 0, RunDetailFooter())
	return strings.Join(visible, "\n") + "\n" + tui.FormatRule(w) + "\n" + footer
}

func paintStatus(line, token, status string, selected bool) string {
	base := tui.RowBase(selected, false)
	head, rest := line[:tui.RowTextIndent], line[tui.RowTextIndent:]
	if !strings.HasPrefix(rest, token) {
		return base.Render(line)
	}
	return base.Render(head) + statusStyle(base, status).Render(token) + base.Render(rest[len(token):])
}

// statusStyle puts the row attributes on the status token. A status with
// no palette slot of its own stays faint and keeps the row style.
func statusStyle(base lipgloss.Style, status string) lipgloss.Style {
	style := tui.DefaultTheme().RunStatusStyle(status)
	if fg, ok := style.GetForeground().(lipgloss.ANSIColor); ok {
		return base.Foreground(fg)
	}
	return base.Faint(true)
}
