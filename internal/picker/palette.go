package picker

import (
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

type PaletteAction struct {
	ID    string
	Entry *workflow.ListEntry
}

func ResolvePaletteLetter(letter string, selected *workflow.ListEntry) *PaletteAction {
	if len([]rune(letter)) != 1 {
		return nil
	}
	key := strings.ToLower(letter)
	switch key {
	case "n":
		return &PaletteAction{ID: "new"}
	case "i":
		return &PaletteAction{ID: "import"}
	case "e":
		return &PaletteAction{ID: "examples"}
	case "c":
		return &PaletteAction{ID: "console"}
	}
	if selected == nil || selected.Error != "" {
		return nil
	}
	switch key {
	case "o":
		e := *selected
		return &PaletteAction{ID: "open", Entry: &e}
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

func FormatPaletteBody(selected *workflow.ListEntry, width int) string {
	rows := []string{
		paletteRow("n", "new", width),
		paletteRow("i", "import", width),
		paletteRow("e", "examples", width),
		paletteRow("c", "console", width),
	}
	if selected == nil || selected.Error != "" {
		return strings.Join(rows, "\n")
	}
	return strings.Join(append(rows,
		paletteRow("o", "edit", width),
		paletteRow("s", "share", width),
		paletteRow("d", "delete", width),
	), "\n")
}

func paletteRow(letter, label string, width int) string {
	return tui.FormatRow(letter+"  "+label, "", false, width, false)
}

type DeleteState struct {
	PendingDelete  *workflow.ListEntry
	DeleteInFlight bool
}

func BeginConfirmedDelete(state *DeleteState) *workflow.ListEntry {
	if state.DeleteInFlight || state.PendingDelete == nil {
		return nil
	}
	entry := state.PendingDelete
	state.PendingDelete = nil
	state.DeleteInFlight = true
	return entry
}

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
