package tui

import "testing"

func TestClipboardErrorNamesCommands(t *testing.T) {
	if errNoClipboard.Error() != "no clipboard command (pbcopy, wl-copy, or xclip)" {
		t.Fatalf("%q", errNoClipboard.Error())
	}
}
