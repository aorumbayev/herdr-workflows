//go:build !windows

package caps

import (
	"os/exec"
	"syscall"
)

func configureProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// KillSpawn kills the whole process group, then the process as fallback.
func KillSpawn(cmd *exec.Cmd) {
	if cmd.Process == nil || cmd.Process.Pid == 0 {
		return
	}
	pid := cmd.Process.Pid
	if syscall.Kill(-pid, syscall.SIGKILL) == nil {
		return
	}
	_ = cmd.Process.Kill()
}