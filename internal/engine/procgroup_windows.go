//go:build windows

package engine

import "os/exec"

func configureProcessGroup(cmd *exec.Cmd) {}