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
	case modePalette:
		body = m.renderPalette()
	case modeConsolePlace:
		body = m.renderConsolePlace()
	case modeEditPlace:
		body = m.renderEditPlace()
	case modeRunsAgentPick:
		body = m.renderRunsAgentPick()
	case modeDelete:
		body = "Delete " + m.deleteLabel() + "?\n" + tui.DeleteConfirmHint
	case modeFail:
		body = m.status + "\n" + tui.FailHint
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

func (m Model) withTabBar(active, body string) string {
	return FormatTabBar(active, m.contentWidth()) + "\n" + body
}

func (m Model) renderNewName() string {
	w := m.contentWidth()
	line := "Workflow name: " + m.promptValue
	hint := tui.CreateNameHint
	if m.status != "" {
		return tui.Truncate(line, w) + "\n" + tui.Truncate(m.status, w) + "\n" + hint
	}
	return tui.Truncate(line, w) + "\n" + hint
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
	return body + "\n" + tui.FormatRule(w) + "\n" + tui.MuteChrome(tui.FormatListFooter(w, 0, 0, tui.PaletteHint))
}

func (m Model) renderList() string {
	opts := m.matched()
	w := m.contentWidth()
	if !HasVisibleEntries(m.entries) {
		parts := []string{tui.FormatDetailBlock(tui.EmptyCatalogMessage, w)}
		if m.status != "" {
			parts = append(parts, tui.Truncate(m.status, w))
		}
		parts = append(parts, tui.FormatRule(w), tui.MuteChrome(tui.FormatListFooter(w, 0, 0, tui.EmptyListHint)))
		return strings.Join(parts, "\n")
	}
	filter := m.listFilterRow(w)
	if len(opts) == 0 {
		return filter + "\n\n" + tui.FormatDetailBlock("No workflows matching "+m.filter, w) + "\n" + tui.FormatRule(w) + "\n" + tui.MuteChrome(tui.FormatListFooter(w, 0, 0, tui.ListHint))
	}
	vp := m.listViewport()
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
	detail := tui.FormatDetailBlock(sel.Description, w)
	footer := tui.MuteChrome(tui.FormatListFooter(w, m.cursor, len(opts), tui.ListHint))
	parts := []string{filter, "", strings.Join(rows, "\n"), "", detail, tui.Truncate(m.status, w), tui.FormatRule(w), footer}
	return strings.Join(parts, "\n")
}

func (m Model) listFilterRow(width int) string {
	hint := ""
	if m.newerRelease {
		hint = FormatFilterUpdateHint(width)
	}
	return FormatListFilterRow(m.filter, width, hint)
}

func (m Model) consentLine() string {
	if m.consent == "" {
		return ""
	}
	return tui.DefaultTheme().Warn.Render(m.consent)
}

// promptBlock gives the field-plus-description block and the hints line for the active input.
func (m Model) promptBlock(width int) (prompt, hints string) {
	if m.prompt == nil {
		return "", ""
	}
	pos, total := m.inputOrdinal()
	return FormatInputPrompt(m.prompt.Spec, width, pos, total), FormatInputHints(m.prompt.Spec)
}

func (m Model) renderChoice() string {
	w := m.contentWidth()
	rows := m.choiceRows()
	vp := m.choiceViewport()
	cursor, offset := tui.ClampListWindow(m.cursor, m.offset, len(rows), vp)
	var lines []string
	end := min(offset+vp, len(rows))
	for i := offset; i < end; i++ {
		lines = append(lines, FormatPickerRowName(rows[i], "", false, w, i == cursor))
	}
	for len(lines) < vp {
		lines = append(lines, "")
	}
	prompt, hints := m.promptBlock(w)
	answers := FormatInputAnswers(m.queue, m.values(), w)
	hint := tui.ChoiceHint
	if m.custom {
		hint = tui.CustomChoiceHint
	}
	footer := tui.MuteChrome(tui.FormatListFooter(w, cursor, len(rows), hint))
	parts := []string{"", strings.Join(lines, "\n"), ""}
	if line := m.consentLine(); line != "" {
		parts = append(parts, line)
	}
	parts = append(parts, prompt)
	if hints != "" {
		parts = append(parts, tui.MuteChrome(hints))
	}
	if answers != "" {
		parts = append(parts, answers)
	}
	if m.status != "" {
		parts = append(parts, tui.Truncate(m.status, w))
	}
	parts = append(parts, tui.FormatRule(w), footer)
	return strings.Join(parts, "\n")
}

func (m Model) renderTextPrompt() string {
	w := m.contentWidth()
	prompt, hints := m.promptBlock(w)
	if prompt == "" {
		prompt = tui.PromptPlaceholder
	}
	answers := FormatInputAnswers(m.queue, m.values(), w)
	parts := []string{}
	if line := m.consentLine(); line != "" {
		parts = append(parts, line)
	}
	parts = append(parts, prompt)
	if hints != "" {
		parts = append(parts, tui.MuteChrome(hints))
	}
	parts = append(parts, m.promptValue)
	if answers != "" {
		parts = append(parts, answers)
	}
	if m.status != "" {
		parts = append(parts, tui.Truncate(m.status, w))
	}
	parts = append(parts, tui.SubmitHint)
	return strings.Join(parts, "\n")
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
