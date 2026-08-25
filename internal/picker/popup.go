package picker

import (
	"encoding/json"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

// PopupStateEnv is the picker state payload for the process that a respawn opens.
const PopupStateEnv = "HWF_PICKER_STATE"

// Popup sizes. herdr cannot resize a live popup, so a path that needs a
// different size closes this popup and opens the next popup at that size.
const (
	compactWidth   = "64"
	compactHeight  = "15"
	expandedWidth  = "85%"
	expandedHeight = "80%"
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
	EditKind string `json:"edit_kind,omitempty"`
	RunID    string `json:"run_id,omitempty"`
	Detail   bool   `json:"detail,omitempty"`
}

// editKindProfile marks a popup edit as a config file, not a workflow file.
const editKindProfile = "profile"

// PopupGeometry is the compact size that both root tabs open at.
func PopupGeometry() (width, height string) {
	return compactWidth, compactHeight
}

// expandedGeometry is the larger size the $EDITOR and run-detail paths need.
func expandedGeometry() (width, height string) {
	return expandedWidth, expandedHeight
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
		state.Width, state.Height = PopupGeometry()
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
	case modeProfiles:
		return tui.TabProfiles
	default:
		return tui.TabWorkflows
	}
}

// popupStateFor is the payload for a respawn that opens tab.
func (m Model) popupStateFor(tab string) PopupState {
	width, height := PopupGeometry()
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

// popupStateForEdit opens the origin tab at the console size with the file that
// the editor uses. Validation then opens a compact popup again.
func (m Model) popupStateForEdit() PopupState {
	tab := tui.TabWorkflows
	if m.editProfile {
		tab = tui.TabProfiles
	}
	state := m.popupStateFor(tab)
	state.Width, state.Height = expandedGeometry()
	state.EditFile, state.EditName = m.editPath, m.editName
	if m.editProfile {
		state.EditKind = editKindProfile
	}
	return state
}

func (m Model) popupStateForRunsDetail(id string) PopupState {
	state := m.popupStateFor(tui.TabRuns)
	state.Width, state.Height = expandedGeometry()
	state.RunID = id
	state.Detail = true
	return state
}

// needsCompactRespawn is true when the live popup is not the compact size.
func (m Model) needsCompactRespawn() bool {
	return compactWidth != m.popupWidth || compactHeight != m.popupHeight
}

// needsExpandedRespawn is true when the live popup is not the expanded size.
func (m Model) needsExpandedRespawn() bool {
	return expandedWidth != m.popupWidth || expandedHeight != m.popupHeight
}
