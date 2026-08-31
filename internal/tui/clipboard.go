package tui

import (
	"errors"
	"os/exec"
	"runtime"
	"strings"
)

// CopyToClipboard writes text with pbcopy, wl-copy, or xclip. OSC 52 is not used
// because a silent multiplexer no-op would claim success (picker-editor-actions).
func CopyToClipboard(text string) error {
	try := func(name string, args ...string) bool {
		cmd := exec.Command(name, args...)
		cmd.Stdin = strings.NewReader(text)
		return cmd.Run() == nil
	}
	if runtime.GOOS == "darwin" && try("pbcopy") {
		return nil
	}
	if try("wl-copy") {
		return nil
	}
	if try("xclip", "-selection", "clipboard") {
		return nil
	}
	return errNoClipboard
}

// PasteFromClipboard reads text with pbpaste, wl-paste, or xclip. OSC 52 is not
// used for the same reason CopyToClipboard avoids it.
func PasteFromClipboard() (string, error) {
	try := func(name string, args ...string) (string, bool) {
		out, err := exec.Command(name, args...).Output()
		if err != nil {
			return "", false
		}
		return string(out), true
	}
	if runtime.GOOS == "darwin" {
		if text, ok := try("pbpaste"); ok {
			return text, nil
		}
	}
	if text, ok := try("wl-paste", "--no-newline"); ok {
		return text, nil
	}
	if text, ok := try("xclip", "-o", "-selection", "clipboard"); ok {
		return text, nil
	}
	return "", errNoPasteClipboard
}

var errNoPasteClipboard = errors.New("no clipboard command (pbpaste, wl-paste, or xclip)")

var errNoClipboard = errors.New("no clipboard command (pbcopy, wl-copy, or xclip)")
