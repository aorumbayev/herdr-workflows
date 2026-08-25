package picker

import (
	"strconv"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

// FormatInputPrompt gives the question in focus: the input name, then its wrapped description.
// The description wraps to at most two indented lines. It is dropped when empty.
func FormatInputPrompt(spec workflow.InputSpec, width int) string {
	desc := strings.TrimSpace(spec.Description)
	if desc == "" {
		return spec.Name
	}
	return spec.Name + "\n" + tui.FormatDetailLines(desc, width)
}

// FormatInputStats packs the progress counter, answer hints, prior answers, and the back hint on one line.
// The prior-answers segment yields to truncation first. The counter, hints, and back hint never drop.
func FormatInputStats(width, pos, total int, hints, answers, back string) string {
	left := strconv.Itoa(pos) + "/" + strconv.Itoa(total)
	if hints != "" {
		left += tui.ChromeSep + hints
	}
	full := left
	if answers != "" {
		full += tui.ChromeSep + answers
	}
	if back != "" {
		full += tui.ChromeSep + back
	}
	if tui.Columns(full) <= width {
		return full
	}
	sep := tui.Columns(tui.ChromeSep)
	budget := width - tui.Columns(left) - tui.Columns(back) - 2*sep
	if answers != "" && budget > tui.Columns(tui.Ellipsis) {
		return left + tui.ChromeSep + tui.Truncate(answers, budget) + tui.ChromeSep + back
	}
	dropped := left
	if back != "" {
		dropped += tui.ChromeSep + back
	}
	return tui.Truncate(dropped, width)
}

// FormatInputHints lists how to answer on one line: the pick or free-text rule, then any custom or length rule.
func FormatInputHints(spec workflow.InputSpec) string {
	return strings.Join(promptHints(spec), tui.ChromeSep)
}

func promptHints(spec workflow.InputSpec) []string {
	if spec.Type == "text" {
		return textPromptHints(spec)
	}
	return choicePromptHints(spec)
}

func textPromptHints(spec workflow.InputSpec) []string {
	hints := []string{"type free text"}
	if spec.Default != nil && *spec.Default != "" {
		hints = append(hints, "default "+*spec.Default)
	}
	return append(hints, minLengthHint(spec)...)
}

func choicePromptHints(spec workflow.InputSpec) []string {
	hints := []string{"pick one"}
	if len(spec.Options) > 0 {
		hints[0] = "pick one of " + strconv.Itoa(len(spec.Options))
	}
	if spec.AllowCustom {
		hints = append(hints, "or type your own")
	}
	return append(hints, minLengthHint(spec)...)
}

func minLengthHint(spec workflow.InputSpec) []string {
	if spec.MinLength == nil || *spec.MinLength <= 0 {
		return nil
	}
	n := *spec.MinLength
	unit := " chars"
	if n == 1 {
		unit = " char"
	}
	return []string{"min " + strconv.Itoa(n) + unit}
}

// FormatInputAnswers lists collected answers in declaration order.
func FormatInputAnswers(queue []workflow.InputSpec, values map[string]string, contentWidth int) string {
	var answered []string
	for _, spec := range queue {
		if _, ok := values[spec.Name]; ok {
			answered = append(answered, spec.Name+"="+values[spec.Name])
		}
	}
	if len(answered) == 0 {
		return ""
	}
	return tui.Truncate("chosen: "+strings.Join(answered, tui.ChromeSep), contentWidth)
}

// FilterChoiceOptions is a case-sensitive substring filter.
func FilterChoiceOptions(options []string, filter string) []string {
	if filter == "" {
		return options
	}
	var out []string
	for _, option := range options {
		if strings.Contains(option, filter) {
			out = append(out, option)
		}
	}
	return out
}

// ShouldRestoreCustomChoiceText is true when a backtrack must put the custom value in the field.
func ShouldRestoreCustomChoiceText(hasAnswer bool, answer string, options []string, allowCustom bool) bool {
	if !hasAnswer || !allowCustom {
		return false
	}
	for _, option := range options {
		if option == answer {
			return false
		}
	}
	return true
}
