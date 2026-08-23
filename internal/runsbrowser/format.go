package runsbrowser

import (
	"path/filepath"
	"strconv"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

const detailViewport = 10

// RunListEmptyOpts names the empty-list copy inputs.
type RunListEmptyOpts struct {
	Scope          Scope
	HasMachineRuns bool
	FilterActive   bool
	Unavailable    bool
}

// FormatRunRowOpts configures list-row layout.
type FormatRunRowOpts struct {
	ShowLocation bool
}

func abbreviateStatus(status string, width int) string {
	full := history.StatusLabel(status)
	if tui.Columns(full) <= width {
		return full
	}
	switch status {
	case "interrupted":
		if width >= 5 {
			return "INTR"
		}
		return "I"
	case "succeeded":
		if width >= 4 {
			return "OK"
		}
		return "O"
	case "failed":
		if width >= 4 {
			return "FAIL"
		}
		return "F"
	case "running":
		if width >= 3 {
			return "RUN"
		}
		return "R"
	case "stale":
		if width >= 3 {
			return "STL"
		}
		return "S"
	default:
		if width >= 3 {
			return "..."
		}
		return ""
	}
}

// FormatRunRow lays out one list row: status, workflow, progress, elapsed, optional location.
func FormatRunRow(item history.Summary, width int, opts FormatRunRowOpts) string {
	status := abbreviateStatus(item.Status, min(12, max(3, width)))
	progress := ""
	if item.Progress != nil {
		progress = strconv.Itoa(item.Progress.Done) + "/" + strconv.Itoa(item.Progress.Total)
	}
	elapsed := history.FormatElapsed(item.ElapsedMs)
	location := ""
	if opts.ShowLocation {
		location = filepath.Base(item.CheckoutRoot)
	}
	fixed := []string{status}
	if progress != "" {
		fixed = append(fixed, progress)
	}
	fixed = append(fixed, elapsed)
	fixedWidth := 0
	for _, part := range fixed {
		fixedWidth += len(part) + len(tui.ChromeSep)
	}
	remain := max(0, width-fixedWidth)
	workflow := item.Title
	if workflow == "" {
		workflow = item.Workflow
	}
	loc := location
	if loc != "" && remain > 0 {
		locBudget := min(tui.Columns(loc), max(0, remain/3))
		loc = tui.Truncate(loc, locBudget)
		if loc != "" {
			remain -= tui.Columns(loc) + tui.Columns(tui.ChromeSep)
		}
	} else {
		loc = ""
	}
	workflow = tui.Truncate(workflow, remain)
	parts := []string{status, workflow}
	if progress != "" {
		parts = append(parts, progress)
	}
	parts = append(parts, elapsed)
	if loc != "" {
		parts = append(parts, loc)
	}
	return strings.Join(filterEmpty(parts), tui.ChromeSep)
}

func filterEmpty(parts []string) []string {
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// FormatRunListEmpty is the detail-area copy when the list has no rows.
func FormatRunListEmpty(opts RunListEmptyOpts) string {
	if opts.Unavailable {
		return "run history unavailable"
	}
	if opts.FilterActive {
		return "no matching runs"
	}
	if !opts.HasMachineRuns {
		return "no workflow has run yet"
	}
	if opts.Scope == ScopeCurrent {
		return "no runs in this worktree" + tui.ChromeSep + "Ctrl+G for All"
	}
	return "no runs"
}

// RunsFooter is the list-mode footer hint plus the scope label.
// tui.FormatListFooter renders the position once. Do not embed the position here.
func RunsFooter(scope Scope, index, total int) string {
	scopeLabel := "Current"
	if scope == ScopeAll {
		scopeLabel = "All"
	}
	_ = index
	_ = total
	return strings.Join([]string{
		"tab workflows",
		"ctrl+g " + scopeLabel,
		"enter detail",
		"esc quit",
	}, tui.ChromeSep)
}

// RunDetailFooter is the detail-mode footer hint.
func RunDetailFooter() string {
	return strings.Join([]string{"esc back", "up/down scroll"}, tui.ChromeSep)
}

// DetailLines renders a detail view into single-width lines.
func DetailLines(view DetailView, width int) []string {
	switch view.Kind {
	case "starting":
		lines := formatStartingDetail(view.Workflow, view.ID, width)
		if view.Message != "" {
			lines = append(lines, asciiGlyphs(tui.Truncate(view.Message, width)))
		}
		return lines
	case "local-failure":
		head := strings.Join([]string{"LAUNCH FAILED", view.Workflow, history.DisplayRunID(view.ID)}, tui.ChromeSep)
		return []string{tui.Truncate(head, width), asciiGlyphs(tui.Truncate(view.Message, width))}
	case "history-unavailable":
		status := "RUNNING"
		if view.Finished != "" {
			status = strings.ToUpper(view.Finished)
		}
		head := strings.Join([]string{status, "HISTORY UNAVAILABLE", view.Workflow}, tui.ChromeSep)
		lines := []string{tui.Truncate(head, width)}
		for _, line := range view.Progress {
			lines = append(lines, asciiGlyphs(tui.Truncate(line, width)))
		}
		if view.Message != "" {
			lines = append(lines, asciiGlyphs(tui.Truncate(view.Message, width)))
		}
		return lines
	default:
		lines := FormatRunDetailLines(view.Blocks, width)
		if len(view.Progress) > 0 {
			lines = append(lines, "")
			for _, line := range view.Progress {
				lines = append(lines, asciiGlyphs(tui.Truncate(line, width)))
			}
		}
		return lines
	}
}

func formatStartingDetail(workflow, id string, width int) []string {
	head := strings.Join([]string{"STARTING", workflow, history.DisplayRunID(id)}, tui.ChromeSep)
	return []string{
		tui.Truncate(head, width),
		tui.Truncate("claiming run history...", width),
	}
}

func asciiGlyphs(line string) string {
	return strings.ReplaceAll(line, "…", "...")
}

// FormatRunDetailLines renders history blocks into width-bounded lines.
func FormatRunDetailLines(blocks []history.Block, width int) []string {
	var out []string
	for _, block := range blocks {
		out = append(out, blockToLines(block, width)...)
	}
	for i, line := range out {
		out[i] = asciiGlyphs(line)
	}
	return out
}

func blockToLines(block history.Block, width int) []string {
	switch block.Kind {
	case "head":
		head := strings.Join(filterEmpty([]string{
			block.Status, block.Title, block.DisplayID, block.Elapsed,
		}), tui.ChromeSep)
		return []string{tui.Truncate(head, width)}
	case "note", "error":
		return []string{tui.Truncate(block.Text, width)}
	default:
		indent := strings.Repeat("  ", block.Depth)
		outcome := ""
		if block.Outcome != "" {
			outcome = tui.ChromeSep + block.Outcome
		}
		label := strconv.Itoa(block.Ordinal) + "/" + strconv.Itoa(block.Total)
		line := tui.Truncate(indent+label+" "+block.Label+outcome, width)
		lines := []string{line}
		if block.Explanation != "" {
			lines = append(lines, tui.Truncate(indent+"  "+block.Explanation, width))
		}
		return lines
	}
}

// ScrollDetailLines returns the visible window and clamped scroll offset.
func ScrollDetailLines(lines []string, scroll, viewport int) ([]string, int) {
	maxScroll := max(0, len(lines)-viewport)
	next := min(max(0, scroll), maxScroll)
	end := min(next+viewport, len(lines))
	return lines[next:end], next
}

// ClampDetailScroll caps scroll to the legal range for lines and viewport.
func ClampDetailScroll(lines []string, scroll, viewport int) int {
	_, next := ScrollDetailLines(lines, scroll, viewport)
	return next
}

// SelectedIndex finds the list cursor for selectedID.
func SelectedIndex(items []history.Summary, selectedID string) int {
	for i, item := range items {
		if item.ID == selectedID {
			return i
		}
	}
	return 0
}

// FormatRunSummary is the one-line runs list detail block.
func FormatRunSummary(item history.Summary) string {
	return strings.Join([]string{
		history.StatusLabel(item.Status),
		item.DisplayID,
		item.CheckoutRoot,
	}, tui.ChromeSep)
}
