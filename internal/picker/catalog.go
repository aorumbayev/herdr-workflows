package picker

import (
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

// FilteredEntries divides a catalog into loadable workflows and load failures.
type FilteredEntries struct {
	Valid   []workflow.ListEntry
	Invalid []workflow.ListEntry
}

// FilterWorkflowEntries omits `hidden: true` entries, then divides the rest by load error.
// A non-empty filter matches displayed title or name and ignores letter case.
func FilterWorkflowEntries(entries []workflow.ListEntry, filter string) FilteredEntries {
	needle := strings.ToLower(filter)
	var matched []workflow.ListEntry
	for _, e := range entries {
		if e.Hidden {
			continue
		}
		if filter != "" {
			title := strings.ToLower(workflow.DisplayTitle(e.Name, e.Title))
			if !strings.Contains(title, needle) && !strings.Contains(strings.ToLower(e.Name), needle) {
				continue
			}
		}
		matched = append(matched, e)
	}
	out := FilteredEntries{}
	for _, e := range matched {
		if e.Error == "" {
			out.Valid = append(out.Valid, e)
		} else {
			out.Invalid = append(out.Invalid, e)
		}
	}
	return out
}

// HasVisibleEntries is true when any catalog entry can show in the picker.
func HasVisibleEntries(entries []workflow.ListEntry) bool {
	for _, e := range entries {
		if !e.Hidden {
			return true
		}
	}
	return false
}
