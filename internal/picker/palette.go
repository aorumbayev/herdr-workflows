package picker

import (
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

// PaletteAction is one ctrl+k letter result.
type PaletteAction struct {
	ID    string
	Route string
	Entry *workflow.WorkflowListEntry
}

// ResolvePaletteLetter maps a bare letter. Selection-dependent actions need a valid row.
func ResolvePaletteLetter(letter string, selected *workflow.WorkflowListEntry) *PaletteAction {
	if len([]rune(letter)) != 1 {
		return nil
	}
	key := strings.ToLower(letter)
	switch key {
	case "n":
		return &PaletteAction{ID: "new", Route: "new"}
	case "i":
		return &PaletteAction{ID: "import", Route: "import"}
	case "e":
		return &PaletteAction{ID: "examples"}
	}
	if selected == nil || selected.Error != "" {
		return nil
	}
	switch key {
	case "o":
		return &PaletteAction{ID: "open", Route: "w=" + selected.Source + ":" + selected.Name}
	case "s":
		e := *selected
		return &PaletteAction{ID: "share", Entry: &e}
	case "d":
		e := *selected
		return &PaletteAction{ID: "delete", Entry: &e}
	default:
		return nil
	}
}

// FormatPaletteBody is the ctrl+k menu. A bare letter fires; no Enter step.
func FormatPaletteBody(selected *workflow.WorkflowListEntry) string {
	lines := []string{"n  Create new", "i  Import", "e  Browse examples"}
	if selected != nil && selected.Error == "" {
		lines = append(lines,
			"o  Open "+selected.Name,
			"s  Share "+selected.Name+" (copy)",
			"d  Delete "+selected.Name,
		)
	} else {
		lines = append(lines,
			"o  Open (needs selection)",
			"s  Share (needs selection)",
			"d  Delete (needs selection)",
		)
	}
	return strings.Join(lines, "\n")
}

// DeleteState is the in-flight guard for y-to-delete.
type DeleteState struct {
	PendingDelete  *workflow.WorkflowListEntry
	DeleteInFlight bool
}

// BeginConfirmedDelete claims the pending target once.
func BeginConfirmedDelete(state *DeleteState) *workflow.WorkflowListEntry {
	if state.DeleteInFlight || state.PendingDelete == nil {
		return nil
	}
	entry := state.PendingDelete
	state.PendingDelete = nil
	state.DeleteInFlight = true
	return entry
}

// ShouldDropStdinLeakSequence drops leaked C0 bytes from the herdr prefix key,
// preserving tab, LF, CR, ESC, Ctrl+K (0x0b), and Ctrl+G (0x07).
func ShouldDropStdinLeakSequence(sequence string) bool {
	if len(sequence) != 1 {
		return false
	}
	b := sequence[0]
	switch b {
	case '\t', '\n', '\r', 0x1b, 0x0b, 0x07:
		return false
	}
	return b < 0x20
}
