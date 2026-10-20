//go:build windows

package caps

import (
	"os/exec"
	"strconv"
)

func configureProcessGroup(cmd *exec.Cmd) {}

// KillSpawn kills the process tree with taskkill, then the process as fallback.
func KillSpawn(cmd *exec.Cmd) {
	if cmd.Process == nil || cmd.Process.Pid == 0 {
		return
	}
	if exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run() == nil {
		return
	}
	_ = cmd.Process.Kill()
}