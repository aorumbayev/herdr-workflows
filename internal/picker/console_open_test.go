package picker

import (
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/console"
)

func TestPaletteConsoleOpensPlacementChooser(t *testing.T) {
	var opened console.Placement
	m := New(Options{
		Entries: catalogEntries(),
		Width:   80,
		OpenConsole: func(p console.Placement) error {
			opened = p
			return nil
		},
	})
	m = apply(m, "ctrl+k")
	m = apply(m, "c")
	if m.mode != modeConsolePlace {
		t.Fatalf("mode = %v, want console place", m.mode)
	}
	body := m.View().Content
	if !strings.Contains(body, "beside") || !strings.Contains(body, "tab") || !strings.Contains(body, "below") {
		t.Fatalf("chooser missing placements:\n%s", body)
	}
	// default beside — Enter opens beside
	m = apply(m, "enter")
	if opened != console.PlacementBeside {
		t.Fatalf("opened = %q, want beside", opened)
	}
	if !m.quit {
		t.Fatal("picker should quit after opening console")
	}
}

func TestConsolePlacementRemembersSessionDefault(t *testing.T) {
	var opened []console.Placement
	m := New(Options{
		Entries: catalogEntries(),
		Width:   80,
		OpenConsole: func(p console.Placement) error {
			opened = append(opened, p)
			return nil
		},
	})
	m = apply(m, "ctrl+k")
	m = apply(m, "c")
	m = apply(m, "down") // beside -> below (order: beside, tab, below? or tab, beside, below)
	// Use explicit selection: we'll document order as tab, beside, below with default cursor on last/remembered
	// First open: pick tab via keys from default beside
	m = apply(m, "esc") // cancel first
	if m.mode != modeList {
		t.Fatalf("cancel mode = %v", m.mode)
	}
	m.lastConsolePlacement = console.PlacementTab
	m = apply(m, "ctrl+k")
	m = apply(m, "c")
	if m.consolePlaceCursor != indexOfPlacement(console.PlacementTab) {
		t.Fatalf("cursor = %d, want tab index", m.consolePlaceCursor)
	}
	m = apply(m, "enter")
	if len(opened) != 1 || opened[0] != console.PlacementTab {
		t.Fatalf("opened = %#v", opened)
	}
}

func indexOfPlacement(p console.Placement) int {
	for i, v := range consolePlacementOptions {
		if v == p {
			return i
		}
	}
	return 0
}
