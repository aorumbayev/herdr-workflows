package picker

import (
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func (m Model) View() tea.View {
	return tea.NewView(m.render())
}

func (m Model) render() string {
	var body string
	switch m.mode {
	case modeRuns:
		body = m.runs.View().Content
	case modePalette:
		body = m.renderPalette()
	case modeDelete:
		body = "Delete " + m.deleteLabel() + "?\n" + tui.DeleteConfirmHint
	case modeFail:
		body = m.status + "\n" + tui.FailHint
	case modeRun:
		body = m.status
		if line := m.consentLine(); line != "" {
			body = line
		}
		body = body + "\n" + tui.RunHint
	case modeInputText:
		body = m.renderTextPrompt()
	case modeInput:
		body = m.renderChoice()
	default:
		body = m.renderList()
	}
	return tui.PadHeight(body, m.height)
}

func (m Model) deleteLabel() string {
	if m.delete.PendingDelete == nil {
		return ""
	}
	return m.delete.PendingDelete.Name
}

func (m Model) renderPalette() string {
	return FormatPaletteBody(m.selectedEntry()) + "\n" + tui.PaletteHint
}

func (m Model) renderList() string {
	opts := m.matched()
	w := m.contentWidth()
	if !HasVisibleEntries(m.entries) {
		return tui.FormatDetailLines(tui.EmptyCatalogMessage, w) + "\n" + tui.FormatRule(w) + "\n" + tui.FormatListFooter(w, 0, 0, tui.EmptyListHint)
	}
	filter := m.listFilterRow(w)
	if len(opts) == 0 {
		return filter + "\n" + tui.FormatDetailLines("No workflows matching "+m.filter, w) + "\n" + tui.FormatRule(w) + "\n" + tui.FormatListFooter(w, 0, 0, tui.ListHint)
	}
	end := min(m.offset+ListViewport, len(opts))
	var rows []string
	for i := m.offset; i < end; i++ {
		entry := opts[i].Entry
		loc := "invalid"
		if entry.Error == "" {
			loc = rowLocation(entry)
		}
		rows = append(rows, FormatPickerRowName(
			workflow.WorkflowDisplayTitle(entry.Name, entry.Title),
			loc,
			len(EntrySensitivity(entry)) > 0,
			w,
			i == m.cursor,
		))
	}
	for len(rows) < ListViewport {
		rows = append(rows, "")
	}
	sel := opts[m.cursor]
	detail := tui.FormatDetailLines(sel.Description, w)
	footer := tui.FormatListFooter(w, m.cursor, len(opts), tui.ListHint)
	return filter + "\n" + strings.Join(rows, "\n") + "\n" + detail + "\n" + tui.FormatRule(w) + "\n" + footer
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

func (m Model) renderChoice() string {
	rows := m.choiceRows()
	w := m.contentWidth()
	var lines []string
	end := min(m.offset+ListViewport, len(rows))
	for i := m.offset; i < end; i++ {
		lines = append(lines, FormatPickerRowName(rows[i], "repo", false, w, i == m.cursor))
	}
	for len(lines) < ListViewport {
		lines = append(lines, "")
	}
	prompt := ""
	if m.prompt != nil {
		pos, total := m.inputOrdinal()
		prompt = FormatInputPrompt(m.prompt.Spec, pos, total)
	}
	answers := FormatInputAnswers(m.queue, m.values(), w)
	hint := tui.ChoiceHint
	if m.custom {
		hint = tui.CustomChoiceHint
	}
	footer := tui.FormatListFooter(w, m.cursor, len(rows), hint)
	parts := []string{strings.Join(lines, "\n")}
	if line := m.consentLine(); line != "" {
		parts = append(parts, line)
	}
	parts = append(parts, prompt)
	if answers != "" {
		parts = append(parts, answers)
	}
	if m.status != "" {
		parts = append(parts, m.status)
	}
	parts = append(parts, tui.FormatRule(w), footer)
	return strings.Join(parts, "\n")
}

func (m Model) renderTextPrompt() string {
	w := m.contentWidth()
	prompt := tui.PromptPlaceholder
	if m.prompt != nil {
		pos, total := m.inputOrdinal()
		prompt = FormatInputPrompt(m.prompt.Spec, pos, total)
	}
	answers := FormatInputAnswers(m.queue, m.values(), w)
	parts := []string{}
	if line := m.consentLine(); line != "" {
		parts = append(parts, line)
	}
	parts = append(parts, prompt, m.promptValue)
	if answers != "" {
		parts = append(parts, answers)
	}
	if m.status != "" {
		parts = append(parts, m.status)
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
