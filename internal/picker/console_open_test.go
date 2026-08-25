package picker

import (
	"errors"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/console"
)

func TestPaletteConsoleOpensPlacementChooser(t *testing.T) {
	var opened console.Placement
	m := New(Options{
		Entries: catalogEntries(),
		Width:   80,
		OpenConsole: func(p console.Placement, _ string) error {
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
	for _, want := range []string{"beside", "below", "new tab"} {
		if !strings.Contains(body, want) {
			t.Fatalf("chooser missing %q:\n%s", want, body)
		}
	}
	// Default beside. Enter opens beside.
	m = apply(m, "enter")
	if opened != console.PlacementBeside {
		t.Fatalf("opened = %q, want beside", opened)
	}
	if !m.quit {
		t.Fatal("picker should quit after opening console")
	}
	if m.lastConsolePlacement != console.PlacementBeside {
		t.Fatalf("remembered = %q, want beside", m.lastConsolePlacement)
	}
}

func TestConsoleChooserDisplaysNewTabForTabValue(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80})
	m = apply(m, "p")
	body := m.View().Content
	if strings.Contains(body, "\ntab") || strings.Contains(body, " tab (") {
		t.Fatalf("raw tab value must not show as a bare option:\n%s", body)
	}
	if !strings.Contains(body, "new tab") {
		t.Fatalf("tab value must display as new tab:\n%s", body)
	}
	if consolePlacementLabel(console.PlacementTab) != "new tab" {
		t.Fatalf("label = %q", consolePlacementLabel(console.PlacementTab))
	}
	if string(console.PlacementTab) != "tab" || string(console.PlacementBeside) != "beside" || string(console.PlacementBelow) != "below" {
		t.Fatal("placement values must stay tab/beside/below")
	}
}

func TestPopOutShortcutAndPaletteAreOneFlow(t *testing.T) {
	m := New(Options{Entries: catalogEntries(), Width: 80, Height: 30})
	// p on the workflows tab opens the chooser and does not type into the filter.
	m = apply(m, "p")
	if m.mode != modeConsolePlace {
		t.Fatalf("p mode = %v, want the chooser", m.mode)
	}
	if m.placeBack != modeList {
		t.Fatalf("placeBack = %v, want list", m.placeBack)
	}
	if m.filter != "" {
		t.Fatalf("p must not type into the filter, got %q", m.filter)
	}
	m = apply(m, "esc")
	// palette c reaches the same chooser.
	m = apply(m, "ctrl+k", "c")
	if m.mode != modeConsolePlace || m.placeBack != modeList {
		t.Fatalf("palette c mode = %v placeBack = %v", m.mode, m.placeBack)
	}
	m = apply(m, "esc")
	// p on the runs tab opens the chooser and returns to runs.
	m = apply(m, "tab")
	if m.mode != modeRuns {
		t.Fatalf("mode = %v, want runs", m.mode)
	}
	m = apply(m, "p")
	if m.mode != modeConsolePlace || m.placeBack != modeRuns {
		t.Fatalf("runs p mode = %v placeBack = %v", m.mode, m.placeBack)
	}
	m = apply(m, "esc")
	if m.mode != modeRuns {
		t.Fatalf("esc from runs chooser mode = %v, want runs", m.mode)
	}
}

func TestConsolePlacementRemembersSessionDefault(t *testing.T) {
	var opened []console.Placement
	m := New(Options{
		Entries: catalogEntries(),
		Width:   80,
		OpenConsole: func(p console.Placement, _ string) error {
			opened = append(opened, p)
			return nil
		},
	})
	m.lastConsolePlacement = console.PlacementTab
	m = apply(m, "p")
	if m.consolePlaceCursor != indexOfPlacement(console.PlacementTab) {
		t.Fatalf("cursor = %d, want tab index", m.consolePlaceCursor)
	}
	m = apply(m, "enter")
	if len(opened) != 1 || opened[0] != console.PlacementTab {
		t.Fatalf("opened = %#v", opened)
	}
}

func TestConsolePlacementRemembersOnlyOnSuccess(t *testing.T) {
	mFail := New(Options{
		Entries:     catalogEntries(),
		Width:       80,
		OpenConsole: func(console.Placement, string) error { return errors.New("no pane host") },
	})
	mFail = apply(mFail, "p", "enter")
	if mFail.lastConsolePlacement != "" {
		t.Fatalf("failed open must not be remembered, got %q", mFail.lastConsolePlacement)
	}

	mOK := New(Options{
		Entries:     catalogEntries(),
		Width:       80,
		OpenConsole: func(console.Placement, string) error { return nil },
	})
	mOK = apply(mOK, "p", "enter")
	if mOK.lastConsolePlacement != console.PlacementBeside {
		t.Fatalf("successful open must be remembered, got %q", mOK.lastConsolePlacement)
	}
}

func TestConsoleOpenFailureStaysInOverlay(t *testing.T) {
	m := New(Options{
		Entries:     catalogEntries(),
		Width:       80,
		Height:      30,
		OpenConsole: func(console.Placement, string) error { return errors.New("dial unix: connection refused") },
	})
	m = apply(m, "p", "enter")
	if m.quit {
		t.Fatal("failed open must not quit the overlay")
	}
	if m.mode != modeList {
		t.Fatalf("mode = %v, want the workflows list", m.mode)
	}
	if m.status == "" {
		t.Fatal("failed open must set a status")
	}
	if strings.Contains(m.status, "connection refused") {
		t.Fatalf("status must not dump the raw error: %q", m.status)
	}
}

func TestConsoleLandsOnSelectedWorkflow(t *testing.T) {
	var landed string
	m := New(Options{
		Entries: catalogEntries(),
		Width:   80,
		Height:  30,
		OpenConsole: func(_ console.Placement, workflow string) error {
			landed = workflow
			return nil
		},
	})
	apply(m, "p", "enter")
	if landed != "chat-handoff" {
		t.Fatalf("landed workflow = %q, want chat-handoff", landed)
	}

	landed = "unset"
	runsM := New(Options{
		Entries: catalogEntries(),
		Width:   80,
		Height:  30,
		OpenConsole: func(_ console.Placement, workflow string) error {
			landed = workflow
			return nil
		},
	})
	apply(runsM, "tab", "p", "enter")
	if landed != "" {
		t.Fatalf("runs pop-out landing = %q, want empty", landed)
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
