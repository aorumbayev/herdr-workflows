package picker

import (
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
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
	return tui.FormatRow(title, location, warned, rowWidth, selected)
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
