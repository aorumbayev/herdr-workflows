package picker

import (
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

// FilteredEntries splits a catalog into loadable workflows and load failures.
type FilteredEntries struct {
	Valid   []workflow.WorkflowListEntry
	Invalid []workflow.WorkflowListEntry
}

// FilterWorkflowEntries hides `hidden: true` entries, then splits the rest by
// load error. A non-empty filter matches displayed title or name, case-insensitively.
func FilterWorkflowEntries(entries []workflow.WorkflowListEntry, filter string) FilteredEntries {
	needle := strings.ToLower(filter)
	var matched []workflow.WorkflowListEntry
	for _, e := range entries {
		if e.Hidden {
			continue
		}
		if filter != "" {
			title := strings.ToLower(workflow.WorkflowDisplayTitle(e.Name, e.Title))
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

// HasVisibleEntries reports whether any catalog entry would appear in the picker.
func HasVisibleEntries(entries []workflow.WorkflowListEntry) bool {
	for _, e := range entries {
		if !e.Hidden {
			return true
		}
	}
	return false
}
