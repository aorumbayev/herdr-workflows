package tui

import (
	"strings"

	"charm.land/lipgloss/v2"
)

// RowRightGutter is the inset between the location column and the content edge.
const RowRightGutter = RowTextIndent

// FormatRow arranges the cursor, title, warning, and location columns.
func FormatRow(title, location string, warned bool, rowWidth int, selected bool) string {
	return assembleRow(title, location, warned, rowWidth, selected, false, false)
}

// FormatStyledRow shows kind, warn, muted location, reverse cursor, and hover underline.
func FormatStyledRow(title, location string, warned bool, rowWidth int, selected, hover bool) string {
	return assembleRow(title, location, warned, rowWidth, selected, hover, true)
}

// RowBase puts the cursor or hover attribute on every cell. An inner SGR reset
// would end that attribute if the row wraps one time.
func RowBase(selected, hover bool) lipgloss.Style {
	base := DefaultTheme().Plain
	if selected {
		return base.Reverse(true)
	}
	if hover {
		return base.Underline(true)
	}
	return base
}

func assembleRow(title, location string, warned bool, rowWidth int, selected, hover, color bool) string {
	prefix := "  "
	if selected {
		prefix = CursorPrefix
	}
	base := RowBase(selected, hover)
	// The title keeps the terminal foreground. Every workflow is the same
	// kind, so a color there would rank rows with no extra meaning.
	cell := func(text string, style lipgloss.Style) string {
		if !color {
			return text
		}
		return style.Render(text)
	}
	plain := base
	// Faint is only on rows that are not the cursor row. The reverse block already ranks it.
	// Faint inside reverse is the one combination that loses contrast.
	muted := base.Faint(!selected)
	warn := base.Foreground(lipgloss.ANSIColor(WarnIndex))
	gutter := strings.Repeat(" ", ColumnGutter)
	right := strings.Repeat(" ", RowRightGutter)
	if location == "" && !warned {
		titleW := max(0, rowWidth-RowTextIndent-RowRightGutter)
		return cell(prefix+" ", plain) + cell(PadColumns(Truncate(title, titleW), titleW), plain) + cell(right, plain)
	}
	warning, warningStyle := " ", plain
	if warned {
		warning, warningStyle = "!", warn
	}
	locationStyle := muted
	if location == "invalid" {
		locationStyle = warn
	}
	titleW := max(0, rowWidth-RowTextIndent-ColumnGutter-WarningWidth-ColumnGutter-LocationWidth-RowRightGutter)
	return cell(prefix+" ", plain) +
		cell(PadColumns(Truncate(title, titleW), titleW), plain) +
		cell(gutter, plain) +
		cell(warning, warningStyle) +
		cell(gutter, plain) +
		cell(padStart(location, LocationWidth), locationStyle) +
		cell(right, plain)
}

func padStart(s string, n int) string {
	w := Columns(s)
	if w >= n {
		return s
	}
	return strings.Repeat(" ", n-w) + s
}
