package picker

import (
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func (m Model) View() tea.View {
	v := tea.NewView(tui.PadHeight(tui.PadContent(m.render(), m.contentWidth()), m.height))
	v.MouseMode = tea.MouseModeAllMotion
	return v
}

func (m Model) render() string {
	var body string
	switch m.mode {
	case modeRuns:
		body = m.withTabBar(tui.TabRuns, m.runs.Body())
	case modeProfiles:
		body = m.withTabBar(tui.TabProfiles, m.renderProfiles())
	case modeProfilePalette:
		body = m.renderProfilePalette()
	case modeNewProfileName:
		body = m.renderNewProfileName()
	case modeNewProfileScope:
		body = m.renderNewProfileScope()
	case modePalette:
		body = m.renderPalette()
	case modeConsolePlace:
		body = m.renderConsolePlace()
	case modeEditPlace:
		body = m.renderEditPlace()
	case modeRunsAgentPick:
		body = m.renderRunsAgentPick()
	case modeNewMode:
		body = m.renderNewMode()
	case modeNewScope:
		body = m.renderNewScope()
	case modeNewAgentPick:
		body = m.renderNewAgentPick()
	case modeDelete:
		body = m.renderConfirm("Delete "+m.deleteLabel()+"?", tui.DeleteConfirmHint)
	case modeFail:
		body = m.renderConfirm(m.status, tui.FailHint)
	case modeNewName:
		body = m.renderNewName()
	case modeInputText:
		body = m.renderTextPrompt()
	case modeInput:
		body = m.renderChoice()
	default:
		body = m.withTabBar(tui.TabWorkflows, m.renderList())
	}
	return body
}

// padToPopup holds tail on the last rows of the popup, so a short screen does not
// float its hint into the middle of an empty frame.
func (m Model) padToPopup(head, tail string) string {
	rows := strings.Count(head, "\n") + strings.Count(tail, "\n") + 2
	return head + strings.Repeat("\n", max(1, m.height-rows+1)) + tail
}

func (m Model) withTabBar(active, body string) string {
	return FormatTabBar(active, m.contentWidth()) + "\n" + body
}

func (m Model) renderNewName() string {
	return m.renderNameField("Workflow name")
}

// renderNameField gives E and H the shape of the free-text prompt: the label on
// its own row, the field flush left, and the edge across the full width.
func (m Model) renderNameField(label string) string {
	w := m.contentWidth()
	head := strings.Join([]string{
		tui.Truncate(label, w),
		tui.MuteChrome(tui.FormatFieldEdge(w)),
		tui.FormatField(m.promptValue, "", w),
		tui.MuteChrome(tui.FormatFieldEdge(w)),
	}, "\n")
	return m.padToPopup(head, tui.Truncate(m.status, w)+"\n"+tui.CreateNameHint)
}

// renderConfirm gives a one-message screen the same rule and footer as a list.
func (m Model) renderConfirm(message, hint string) string {
	w := m.contentWidth()
	tail := tui.FormatRule(w) + "\n" + tui.MuteChrome(tui.FormatListFooter(w, 0, 0, hint))
	return m.padToPopup(tui.FormatDetailBlock(message, w), tail)
}

func (m Model) deleteLabel() string {
	if m.delete.PendingDelete == nil {
		return ""
	}
	return m.delete.PendingDelete.Name
}

func (m Model) renderPalette() string {
	w := m.contentWidth()
	body := FormatPaletteBody(m.selectedEntry(), w)
	return m.padToPopup(body, tui.FormatRule(w)+"\n"+tui.MuteChrome(tui.FormatListFooter(w, 0, 0, tui.PaletteHint)))
}

func (m Model) renderList() string {
	opts := m.matched()
	w := m.contentWidth()
	vp := m.listViewport()
	if !HasVisibleEntries(m.entries) {
		body := tui.PadHeight(tui.FormatDetailBlock(tui.EmptyCatalogMessage, w), vp+3)
		return m.listTail(w, body, tui.FormatDetailBlock("", w), tui.EmptyListHint, 0, 0)
	}
	filter := m.listFilterRow(w)
	edge := m.listFilterEdge(w)
	if len(opts) == 0 {
		body := tui.PadHeight(tui.FormatDetailBlock("No workflows matching "+m.filter, w), vp)
		return edge + "\n" + filter + "\n" + edge + "\n" + m.listTail(w, body, tui.FormatDetailBlock("", w), tui.ListHint, 0, 0)
	}
	end := min(m.offset+vp, len(opts))
	var rows []string
	for i := m.offset; i < end; i++ {
		entry := opts[i].Entry
		loc := "invalid"
		if entry.Error == "" {
			loc = rowLocation(entry)
		}
		rows = append(rows, tui.FormatStyledRow(
			workflow.DisplayTitle(entry.Name, entry.Title),
			loc,
			len(EntrySensitivity(entry)) > 0,
			w,
			i == m.cursor,
			i == m.hoverRow && i != m.cursor,
		))
	}
	for len(rows) < vp {
		rows = append(rows, "")
	}
	sel := opts[m.cursor]
	body := strings.Join(rows, "\n")
	detail := tui.FormatDetailBlock(sel.Description, w)
	return edge + "\n" + filter + "\n" + edge + "\n" + m.listTail(w, body, detail, tui.ListHint, m.cursor, len(opts))
}

// listTail holds the rows below the filter at fixed positions, so an empty list
// cannot float the rule and the footer up the popup. The status row sits above
// the detail block, so a one-line description still lands on the rule.
func (m Model) listTail(w int, body, detail, hint string, index, total int) string {
	parts := []string{body, "", tui.Truncate(m.status, w), detail, tui.FormatRule(w), tui.MuteChrome(tui.FormatListFooter(w, index, total, hint))}
	return strings.Join(parts, "\n")
}

func (m Model) listFilterRow(width int) string {
	hint := ""
	if m.newerRelease {
		hint = FormatFilterUpdateHint(width)
	}
	return FormatListFilterRow(m.filter, width, hint)
}

func (m Model) listFilterEdge(width int) string {
	return tui.MuteChrome(FormatListFilterEdge(width))
}

// sensitivityLine is a compact muted note of the touched surfaces, shown only when the workflow is sensitive.
func (m Model) sensitivityLine(width int) string {
	if len(m.sensitivity) == 0 {
		return ""
	}
	return tui.MuteChrome(tui.Truncate(tui.TouchesPrefix+strings.Join(m.sensitivity, ", "), width))
}

func (m Model) choiceFilterRow(width int) string {
	return tui.FormatField(m.filter, tui.FilterOptions, width)
}

// promptHeader is the input name and its wrapped description, the question in focus.
func (m Model) promptHeader(width int) string {
	if m.prompt == nil {
		return tui.PromptPlaceholder
	}
	return FormatInputPrompt(m.prompt.Spec, width)
}

// statsLine demotes progress, answer hints, prior answers, and the back hint to one muted line.
func (m Model) statsLine(width int) string {
	hints := ""
	if m.prompt != nil {
		hints = FormatInputHints(m.prompt.Spec)
	}
	pos, total := m.inputOrdinal()
	answers := FormatInputAnswers(m.queue, m.values(), width)
	return tui.MuteChrome(FormatInputStats(width, pos, total, hints, answers, tui.BackHint))
}

func (m Model) renderChoice() string {
	w := m.contentWidth()
	rows := m.choiceRows()
	vp := m.choiceViewport()
	cursor, offset := tui.ClampListWindow(m.cursor, m.offset, len(rows), vp)
	var lines []string
	if len(rows) == 0 {
		lines = strings.Split(tui.PadHeight(tui.FormatDetailBlock("No options matching "+m.filter, w), vp), "\n")
	}
	end := min(offset+vp, len(rows))
	for i := offset; i < end; i++ {
		lines = append(lines, FormatPickerRowName(rows[i], "", false, w, i == cursor))
	}
	for len(lines) < vp {
		lines = append(lines, "")
	}
	parts := []string{
		m.promptHeader(w), "",
		strings.Join(lines, "\n"),
		tui.MuteChrome(tui.FormatFieldEdge(w)),
		m.choiceFilterRow(w),
		tui.MuteChrome(tui.FormatFieldEdge(w)),
		m.statsLine(w),
	}
	if line := m.sensitivityLine(w); line != "" {
		parts = append(parts, line)
	}
	if m.status != "" {
		parts = append(parts, tui.Truncate(m.status, w))
	}
	return strings.Join(parts, "\n")
}

func (m Model) renderTextPrompt() string {
	w := m.contentWidth()
	head := strings.Join([]string{
		m.promptHeader(w),
		tui.MuteChrome(tui.FormatFieldEdge(w)),
		tui.FormatField(m.promptValue, tui.PromptPlaceholder, w),
		tui.MuteChrome(tui.FormatFieldEdge(w)),
	}, "\n")
	parts := []string{m.statsLine(w)}
	if line := m.sensitivityLine(w); line != "" {
		parts = append(parts, line)
	}
	if m.status != "" {
		parts = append(parts, tui.Truncate(m.status, w))
	}
	return m.padToPopup(head, strings.Join(parts, "\n"))
}

func (m Model) values() map[string]string {
	if m.session == nil {
		return nil
	}
	return m.session.Values()
}

func (m Model) inputOrdinal() (int, int) {
	answered := 0
	if vals := m.values(); vals != nil {
		answered = len(vals)
	}
	total := len(m.queue)
	if total < answered+1 {
		total = answered + 1
	}
	if total == 0 {
		return 0, 0
	}
	return answered + 1, total
}
