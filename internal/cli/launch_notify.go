package cli

import (
	"os"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/engine"
	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/charmbracelet/x/term"
	"github.com/spf13/cobra"
)

const launchNotifyTitle = "herdr-workflows"

// isTerminalFile is a seam. A test cannot open a pseudo terminal portably.
var isTerminalFile = func(f *os.File) bool { return term.IsTerminal(f.Fd()) }

// runIsDetached is true when no interactive terminal reads the run output, so
// nobody sees the printed outcome. A picker launch and a nohup run are both detached.
func runIsDetached(cmd *cobra.Command) bool {
	out, ok := cmd.OutOrStdout().(*os.File)
	if !ok {
		return true
	}
	return !isTerminalFile(out)
}

// notifyRunOutcome toasts the outcome of a detached run. The picker closes on the
// claim, so the child is the only process left to report it.
func notifyRunOutcome(runID, title string, getenv config.Env) {
	detail := history.RunDetail(runID, getenv, time.Time{}).Detail
	elapsed := history.FormatElapsed(detail.ElapsedMs)
	if detail.Status == string(engine.StatusSucceeded) {
		_ = host.NotificationShowSound(launchNotifyTitle, title+" succeeded in "+elapsed, "done")
		return
	}
	body := title + " failed after " + elapsed + " - " + history.DisplayRunID(runID)
	_ = host.NotificationShowSound(launchNotifyTitle, body, "none")
}
