package picker

import (
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

const (
	selectNameOffset  = 1
	cursorPrefixWidth = 2
	locationWidth     = 7
	warningWidth      = 2
)

// ChromeOption is one picker list row.
type ChromeOption struct {
	Name        string
	Description string
	Entry       workflow.WorkflowListEntry
}

// EntrySensitivity returns the compact trust labels for a catalog row.
func EntrySensitivity(entry workflow.WorkflowListEntry) []string {
	return workflow.SensitivityLabels(workflow.WorkflowSensitivity{
		HasCommands:        entry.HasCommands,
		HasTranscript:      entry.NeedsTranscript,
		SensitiveMethods:   entry.SensitiveMethods,
		UnresolvedChildren: entry.UnresolvedChildren,
	})
}

// FormatConsentLine names the workflow, source, and sensitivity flags.
func FormatConsentLine(entry workflow.WorkflowListEntry) string {
	flags := EntrySensitivity(entry)
	if len(flags) == 0 {
		return ""
	}
	return workflow.WorkflowDisplayTitle(entry.Name, entry.Title) + tui.ChromeSep + entry.Source + tui.ChromeSep + strings.Join(flags, tui.ChromeSep)
}

// FormatPickerRowName lays out cursor, title, warning, and location columns.
func FormatPickerRowName(title, location string, warned bool, rowWidth int, selected bool) string {
	titleW := max(0, rowWidth-selectNameOffset-cursorPrefixWidth-1-warningWidth-locationWidth)
	prefix := "  "
	if selected {
		prefix = "> "
	}
	warning := "  "
	if warned {
		warning = "! "
	}
	return prefix + tui.PadColumns(tui.Truncate(title, titleW), titleW) + " " + warning + padStart(location, locationWidth)
}

func padStart(s string, n int) string {
	w := tui.Columns(s)
	if w >= n {
		return s
	}
	return strings.Repeat(" ", n-w) + s
}

func rowLocation(entry workflow.WorkflowListEntry) string {
	if entry.Source == "repo" {
		return "repo"
	}
	return "global"
}

// BuildPickerOptions formats valid catalog rows.
func BuildPickerOptions(valid []workflow.WorkflowListEntry, rowWidth int) []ChromeOption {
	out := make([]ChromeOption, 0, len(valid))
	for _, entry := range valid {
		desc := strings.TrimSpace(entry.Description)
		if desc == "" {
			desc = entry.Name
		}
		out = append(out, ChromeOption{
			Name: FormatPickerRowName(
				workflow.WorkflowDisplayTitle(entry.Name, entry.Title),
				rowLocation(entry),
				len(EntrySensitivity(entry)) > 0,
				rowWidth,
				false,
			),
			Description: desc,
			Entry:       entry,
		})
	}
	return out
}

// StripFilePrefix removes a leading file path from a load error.
func StripFilePrefix(errText, file string) string {
	if strings.HasPrefix(errText, file) {
		rest := errText[len(file):]
		return strings.TrimLeft(strings.TrimPrefix(strings.TrimPrefix(rest, ","), ":"), " ")
	}
	return errText
}

// BuildInvalidOptions formats load-failure rows with location `invalid`.
func BuildInvalidOptions(invalid []workflow.WorkflowListEntry, rowWidth int) []ChromeOption {
	out := make([]ChromeOption, 0, len(invalid))
	for _, entry := range invalid {
		out = append(out, ChromeOption{
			Name: FormatPickerRowName(
				workflow.WorkflowDisplayTitle(entry.Name, entry.Title),
				"invalid",
				len(EntrySensitivity(entry)) > 0,
				rowWidth,
				false,
			),
			Description: StripFilePrefix(entry.Error, entry.File),
			Entry:       entry,
		})
	}
	return out
}
