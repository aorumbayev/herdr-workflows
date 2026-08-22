package picker

import (
	"os/exec"
	"runtime"
	"strings"
)

// CopyToClipboard writes text via pbcopy, wl-copy, or xclip. OSC 52 is not used
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

type clipboardError struct{}

func (clipboardError) Error() string {
	return "no clipboard command (pbcopy, wl-copy, or xclip)"
}

var errNoClipboard clipboardError
