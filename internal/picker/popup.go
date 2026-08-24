package picker

import (
	"encoding/json"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

// PopupStateEnv is the picker state payload for the process that a respawn opens.
const PopupStateEnv = "HWF_PICKER_STATE"

// Popup sizes. herdr cannot resize a live popup, so a tab that needs a
// different size closes this popup and opens the next popup at that size.
const (
	compactWidth  = "64"
	compactHeight = "15"
	consoleWidth  = "85%"
	consoleHeight = "80%"
)

// PopupState is the state that a respawned picker restores, plus the size that it opens at.
type PopupState struct {
	Tab    string `json:"tab"`
	Filter string `json:"filter"`
	Cursor int    `json:"cursor"`
	Offset int    `json:"offset"`
	Width  string `json:"width"`
	Height string `json:"height"`
	// EditFile and EditName keep the in-popup edit across the respawn that
	// gives $EDITOR the console size.
	EditFile string `json:"edit_file,omitempty"`
	EditName string `json:"edit_name,omitempty"`
	RunID    string `json:"run_id,omitempty"`
	Detail   bool   `json:"detail,omitempty"`
}

// PopupGeometry is the popup size a root tab needs.
func PopupGeometry(tab string) (width, height string) {
	if tab == tui.TabConsole {
		return consoleWidth, consoleHeight
	}
	return compactWidth, compactHeight
}

// ParsePopupState decodes a respawn payload. Unreadable state starts with no restore data.
func ParsePopupState(payload string) *PopupState {
	payload = strings.TrimSpace(payload)
	if payload == "" {
		return nil
	}
	var state PopupState
	if err := json.Unmarshal([]byte(payload), &state); err != nil {
		return nil
	}
	if state.Width == "" || state.Height == "" {
		state.Width, state.Height = PopupGeometry(state.Tab)
	}
	return &state
}

// Encode makes the payload that the respawned process reads.
func (s PopupState) Encode() string {
	body, err := json.Marshal(s)
	if err != nil {
		return ""
	}
	return string(body)
}

func (m Model) currentTabName() string {
	switch m.mode {
	case modeRuns:
		return tui.TabRuns
	case modeConsole:
		return tui.TabConsole
	default:
		return tui.TabWorkflows
	}
}

// popupStateFor is the payload for a respawn that opens tab.
func (m Model) popupStateFor(tab string) PopupState {
	width, height := PopupGeometry(tab)
	state := PopupState{
		Tab:    tab,
		Filter: m.filter,
		Cursor: m.cursor,
		Offset: m.offset,
		Width:  width,
		Height: height,
	}
	if tab == tui.TabRuns {
		state.RunID = m.runs.SelectedID()
		if state.RunID == "" {
			state.RunID = m.runs.ActiveRunID()
		}
	}
	return state
}

// popupStateForEdit opens the workflows tab at the console size with the file
// that the editor uses. Validation then opens a compact popup again.
func (m Model) popupStateForEdit(entry workflow.ListEntry) PopupState {
	state := m.popupStateFor(tui.TabWorkflows)
	state.Width, state.Height = consoleWidth, consoleHeight
	state.EditFile, state.EditName = entry.File, entry.Name
	return state
}

func (m Model) popupStateForRunsDetail(id string) PopupState {
	state := m.popupStateFor(tui.TabRuns)
	state.Width, state.Height = consoleWidth, consoleHeight
	state.RunID = id
	state.Detail = true
	return state
}

// needsRespawn is true when tab needs a popup size that this process did not open.
// A comparison with the live size stops a respawn loop.
func (m Model) needsRespawn(tab string) bool {
	width, height := PopupGeometry(tab)
	return width != m.popupWidth || height != m.popupHeight
}
