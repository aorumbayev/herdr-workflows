package tui

import "strings"

// RowRightGutter is the inset between the location column and the content edge.
const RowRightGutter = RowTextIndent

// FormatRow lays out cursor, title, warning, and location columns.
func FormatRow(title, location string, warned bool, rowWidth int, selected bool) string {
	prefix := "  "
	if selected {
		prefix = CursorPrefix
	}
	if location == "" && !warned {
		titleW := max(0, rowWidth-RowTextIndent-RowRightGutter)
		return prefix + " " + PadColumns(Truncate(title, titleW), titleW) + strings.Repeat(" ", RowRightGutter)
	}
	gutter := strings.Repeat(" ", ColumnGutter)
	warning := " "
	if warned {
		warning = "!"
	}
	titleW := max(0, rowWidth-RowTextIndent-ColumnGutter-WarningWidth-ColumnGutter-LocationWidth-RowRightGutter)
	return prefix + " " + PadColumns(Truncate(title, titleW), titleW) + gutter + warning + gutter + padStart(location, LocationWidth) + strings.Repeat(" ", RowRightGutter)
}

func padStart(s string, n int) string {
	w := Columns(s)
	if w >= n {
		return s
	}
	return strings.Repeat(" ", n-w) + s
}
