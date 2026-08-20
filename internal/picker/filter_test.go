package picker

import (
	"testing"

	tea "charm.land/bubbletea/v2"
)

func TestFilterInputDropsLeakedControlKeys(t *testing.T) {
	drop := FilterInput(nil, tea.KeyPressMsg{Code: 'e', Mod: tea.ModCtrl})
	if drop != nil {
		t.Fatal("ctrl+e must drop")
	}
	keep := FilterInput(nil, tea.KeyPressMsg{Code: 'k', Mod: tea.ModCtrl})
	if keep == nil {
		t.Fatal("ctrl+k must survive")
	}
	if FilterInput(nil, tea.KeyPressMsg{Code: tea.KeyTab}) == nil {
		t.Fatal("tab must survive")
	}
}

func TestClipboardErrorNamesCommands(t *testing.T) {
	if errNoClipboard.Error() != "no clipboard command (pbcopy, wl-copy, or xclip)" {
		t.Fatalf("%q", errNoClipboard.Error())
	}
}
