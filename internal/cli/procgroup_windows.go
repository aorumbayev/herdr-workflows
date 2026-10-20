//go:build windows

package cli

import "os/exec"

func configureProcessGroup(cmd *exec.Cmd) {}
