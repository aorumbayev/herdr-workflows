package picker

import (
	"os"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

func TestPopupGeometryPerTab(t *testing.T) {
	w, h := PopupGeometry(tui.TabWorkflows)
	if w != "64" || h != "15" {
		t.Fatalf("workflows geometry = %s by %s, want the compact size", w, h)
	}
	if rw, rh := PopupGeometry(tui.TabRuns); rw != w || rh != h {
		t.Fatalf("runs geometry = %s by %s, want the compact size", rw, rh)
	}
	cw, ch := PopupGeometry(tui.TabConsole)
	if cw != "85%" || ch != "80%" {
		t.Fatalf("console geometry = %s by %s, want 85%% by 80%%", cw, ch)
	}
}

func TestTabSwitchRespawnsOnlyOnSizeChange(t *testing.T) {
	var got []PopupState
	newModel := func() Model {
		return New(Options{
			Entries:     eightEntries(),
			Width:       64,
			Height:      15,
			ReopenPopup: func(state PopupState) error { got = append(got, state); return nil },
		})
	}
	m := apply(newModel(), "down", "tab")
	if len(got) != 0 {
		t.Fatalf("same-size switch must not respawn, got %+v", got)
	}
	if m.mode != modeRuns {
		t.Fatalf("mode = %v, want runs", m.mode)
	}
	m = apply(m, "tab")
	if len(got) != 1 {
		t.Fatalf("console switch must respawn once, got %d", len(got))
	}
	if !m.quit {
		t.Fatal("respawning picker must quit so the popup can close")
	}
	state := got[0]
	if state.Tab != tui.TabConsole || state.Width != "85%" || state.Height != "80%" {
		t.Fatalf("state = %+v, want the console tab at its own size", state)
	}
	if state.Cursor != 1 {
		t.Fatalf("state cursor = %d, want the row the user left on", state.Cursor)
	}
}

func TestRestoredPickerMountsItsTabWithoutRespawning(t *testing.T) {
	var got []PopupState
	state := PopupState{Tab: tui.TabConsole, Cursor: 1, Width: "85%", Height: "80%"}
	m := New(Options{
		Entries:     eightEntries(),
		Width:       120,
		Height:      40,
		Restore:     &state,
		ReopenPopup: func(s PopupState) error { got = append(got, s); return nil },
	})
	if m.cursor != 1 {
		t.Fatalf("cursor = %d, want the restored row", m.cursor)
	}
	m = runCmd(m, m.Init())
	if m.mode != modeConsole {
		t.Fatalf("mode = %v, want the restored console tab", m.mode)
	}
	if len(got) != 0 {
		t.Fatalf("restored picker must not respawn, got %+v", got)
	}
	m = apply(m, "tab")
	if len(got) != 1 || got[0].Tab != tui.TabWorkflows {
		t.Fatalf("leaving console must respawn compact, got %+v", got)
	}
}

func TestRunDetailExpandsThenRespawnsCompact(t *testing.T) {
	checkout := t.TempDir()
	stateDir := t.TempDir()
	getenv := func(key string) string {
		if key == "HERDR_PLUGIN_STATE_DIR" {
			return stateDir
		}
		return os.Getenv(key)
	}
	seedFailedRun(t, getenv, checkout)
	var states []PopupState
	m := New(Options{
		Entries:     eightEntries(),
		RepoRoot:    checkout,
		Width:       64,
		Height:      15,
		Env:         getenv,
		ReopenPopup: func(state PopupState) error { states = append(states, state); return nil },
	})
	m = apply(m, "tab", "enter")
	if !m.quit {
		t.Fatal("run detail must quit the compact popup")
	}
	if len(states) != 1 {
		t.Fatalf("states = %v", states)
	}
	if states[0].Tab != tui.TabRuns || !states[0].Detail || states[0].RunID == "" {
		t.Fatalf("detail state = %+v", states[0])
	}
	if states[0].Width != consoleWidth || states[0].Height != consoleHeight {
		t.Fatalf("detail popup opens compact: %+v", states[0])
	}

	var back []PopupState
	restored := New(Options{
		Entries:  eightEntries(),
		RepoRoot: checkout,
		Width:    120,
		Height:   40,
		Env:      getenv,
		Restore:  &states[0],
		ReopenPopup: func(state PopupState) error {
			back = append(back, state)
			return nil
		},
	})
	restored = runCmd(restored, restored.Init())
	if restored.mode != modeRuns || restored.runs.IsList() {
		t.Fatalf("restored picker must open run detail, mode=%v list=%v", restored.mode, restored.runs.IsList())
	}
	if restored.runs.ActiveRunID() != states[0].RunID {
		t.Fatalf("restored run = %q want %q", restored.runs.ActiveRunID(), states[0].RunID)
	}
	if len(back) != 0 {
		t.Fatalf("restored detail must not respawn, got %+v", back)
	}

	restored = apply(restored, "esc")
	if !restored.quit {
		t.Fatal("leaving detail must quit into the compact respawn")
	}
	if len(back) != 1 {
		t.Fatalf("escape must respawn compact, got %v", back)
	}
	if back[0].Tab != tui.TabRuns || back[0].Detail || back[0].Width != compactWidth || back[0].Height != compactHeight {
		t.Fatalf("compact respawn = %+v", back[0])
	}
	if back[0].RunID != states[0].RunID {
		t.Fatalf("compact respawn lost run %q: %+v", states[0].RunID, back[0])
	}

	listed := New(Options{
		Entries:     eightEntries(),
		RepoRoot:    checkout,
		Width:       64,
		Height:      15,
		Env:         getenv,
		Restore:     &back[0],
		ReopenPopup: func(PopupState) error { t.Fatal("compact runs list must not respawn"); return nil },
	})
	listed = runCmd(listed, listed.Init())
	if listed.mode != modeRuns || !listed.runs.IsList() {
		t.Fatalf("compact restore must be the runs list, mode=%v list=%v", listed.mode, listed.runs.IsList())
	}
	if listed.runs.SelectedID() != states[0].RunID {
		t.Fatalf("list selection = %q want %q", listed.runs.SelectedID(), states[0].RunID)
	}
}

func TestParsePopupStateRejectsGarbage(t *testing.T) {
	if ParsePopupState("") != nil || ParsePopupState("{oops") != nil {
		t.Fatal("unreadable state must start fresh")
	}
	state := ParsePopupState(PopupState{Tab: tui.TabConsole}.Encode())
	if state == nil || state.Width != "85%" {
		t.Fatalf("state = %+v, want the console size filled in", state)
	}
}
