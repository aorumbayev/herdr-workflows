package runsbrowser

import (
	"fmt"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

const sourceFallback = "(step source unavailable)"

func detailCards(detail history.Detail, focus int) []tui.CardSpec {
	cards := make([]tui.CardSpec, 0, len(detail.Steps)+1)
	for i, step := range detail.Steps {
		outcome := step.Outcome
		if outcome == "" && step.Active {
			outcome = "running"
		}
		if step.Truncated {
			outcome += " (truncated read)"
		}
		cards = append(cards, stepCard(step, outcome, i == focus))
	}
	if detail.CurrentStep != nil && detail.CurrentStep.Active {
		cards = append(cards, stepCard(*detail.CurrentStep, "running", focus == len(detail.Steps)))
	}
	return cards
}

func stepCard(step history.DetailStep, outcome string, focused bool) tui.CardSpec {
	kind, title := step.Action, step.StepID
	if kind == "" {
		kind = "step"
	}
	if title == "" {
		title = step.Label
	}
	return tui.CardSpec{Kind: kind, Title: title, Body: []string{outcome}, Focused: focused, Muted: true}
}

func defaultStepFocus(detail history.Detail) int {
	for i := len(detail.Steps) - 1; i >= 0; i-- {
		switch detail.Steps[i].Outcome {
		case "failed", "failed_continued", "interrupted":
			return i
		}
	}
	if n := len(detail.Steps); n > 0 {
		return n - 1
	}
	return 0
}

func stepCount(detail history.Detail) int {
	n := len(detail.Steps)
	if detail.CurrentStep != nil && detail.CurrentStep.Active {
		n++
	}
	return n
}

func focusedStep(detail history.Detail, focus int) (history.DetailStep, bool) {
	if focus >= 0 && focus < len(detail.Steps) {
		return detail.Steps[focus], true
	}
	if detail.CurrentStep != nil && detail.CurrentStep.Active && focus == len(detail.Steps) {
		return *detail.CurrentStep, true
	}
	return history.DetailStep{}, false
}

func StepCause(step history.DetailStep) string { return stepCause(step) }

func stepCause(step history.DetailStep) string {
	fact := step.Failure
	kind := step.Action
	if fact != nil && fact.Action != "" {
		kind = fact.Action
	}
	switch kind {
	case "run":
		return "run command failed"
	case "agent":
		if fact != nil && fact.Verdict != "" {
			return "agent verdict " + fact.Verdict
		}
		if fact != nil && fact.Coordination != "" {
			return "agent coordination " + fact.Coordination
		}
		return "agent step failed"
	case "herdr":
		if fact != nil && fact.Method != "" {
			return "herdr " + fact.Method + " failed"
		}
		return "herdr call failed"
	case "workflow":
		return "workflow step failed"
	default:
		if step.Outcome == "running" || step.Active {
			return "step running"
		}
		if step.Outcome == "succeeded" || step.Outcome == "skipped" || step.Outcome == "launched" {
			return step.Outcome
		}
		return "step failed"
	}
}

func stepSource(chunks []string, step history.DetailStep) string {
	idx := step.Ordinal - 1
	if idx >= 0 && idx < len(chunks) && strings.TrimSpace(chunks[idx]) != "" {
		return chunks[idx]
	}
	return sourceFallback
}

func detailPaneLines(detail history.Detail, step history.DetailStep, chunks []string, width int) []string {
	theme := tui.DefaultTheme()
	title := detail.Title
	if title == "" {
		title = detail.Workflow
	}
	head := strings.Join(filterEmpty([]string{
		history.StatusLabel(detail.Status), title, detail.DisplayID, history.FormatElapsed(detail.ElapsedMs),
	}), tui.ChromeSep)
	lines := []string{tui.Truncate(head, width)}
	lines = append(lines, tui.Truncate(stepCause(step), width))
	cmd := step.Label
	exit := ""
	if step.Failure != nil && step.Failure.ExitCode != nil {
		exit = fmt.Sprintf("exit %d", *step.Failure.ExitCode)
	}
	if cmd != "" || exit != "" {
		lines = append(lines, tui.Truncate(strings.Join(filterEmpty([]string{cmd, exit}), tui.ChromeSep), width))
	}
	if tail := strings.TrimSpace(step.Explanation); tail != "" {
		for _, line := range strings.Split(strings.ReplaceAll(asciiGlyphs(tail), "\r\n", "\n"), "\n") {
			lines = append(lines, theme.Muted.Render(tui.Truncate(strings.TrimRight(line, "\r"), width)))
		}
	}
	src := stepSource(chunks, step)
	for _, line := range strings.Split(tui.ColorYAML(src), "\n") {
		lines = append(lines, tui.Truncate(line, width))
	}
	if detail.Remaining != nil && *detail.Remaining > 0 {
		noun := "steps"
		if *detail.Remaining == 1 {
			noun = "step"
		}
		lines = append(lines, theme.Muted.Render(tui.Truncate(fmt.Sprintf("%d %s not run", *detail.Remaining, noun), width)))
	}
	return lines
}

func (m Model) renderRailDetail() string {
	w := m.contentWidth()
	leftW, rightW := tui.RailSplit(w)
	cards := detailCards(m.detailView.Detail, m.stepFocus)
	rail, _ := tui.RenderRail(cards, leftW, m.detailRows(), m.detailScroll)
	var pane string
	if step, ok := focusedStep(m.detailView.Detail, m.stepFocus); ok {
		lines := detailPaneLines(m.detailView.Detail, step, m.yamlChunks, rightW)
		visible, _ := ScrollDetailLines(lines, m.yamlScroll, m.detailRows())
		pane = strings.Join(visible, "\n")
	}
	footer := tui.FormatListFooter(w, 0, 0, RunDetailFooter())
	return tui.JoinRail(rail, pane, leftW, m.detailRows()) + "\n" + tui.FormatRule(w) + "\n" + footer
}
