package cli

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/picker"
)

// reopenAttempts and reopenDelay bound the wait for the outgoing popup to die.
// A popup is a session singleton, so the next open fails until it is gone.
const (
	reopenAttempts = 60
	reopenDelay    = 50 * time.Millisecond
)

// popupEnv is what a respawned picker inherits through plugin.pane.open.
func popupEnv(state picker.PopupState) map[string]string {
	env := map[string]string{picker.PopupStateEnv: state.Encode()}
	for _, key := range []string{"HERDR_WORKFLOWS_REPO_ROOT", "HERDR_PLUGIN_CONTEXT_JSON"} {
		if v := os.Getenv(key); v != "" {
			env[key] = v
		}
	}
	return env
}

// spawnPopupReopen hands the respawn to a detached child, because this process
// dies with the popup it is asked to replace.
func spawnPopupReopen(state picker.PopupState) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "picker", "--reopen")
	cmd.Env = append(os.Environ(), picker.PopupStateEnv+"="+state.Encode())
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer func() { _ = null.Close() }()
	cmd.Stdin, cmd.Stdout, cmd.Stderr = null, null, null
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// runPopupReopen is the detached child: it waits out the closing popup, then
// opens the next one at the size its tab needs.
func runPopupReopen() error {
	state := picker.ParsePopupState(os.Getenv(picker.PopupStateEnv))
	if state == nil {
		return nil
	}
	env := popupEnv(*state)
	var err error
	for attempt := 0; attempt < reopenAttempts; attempt++ {
		err = host.PluginPaneOpenPopup("picker", env, state.Width, state.Height)
		if err == nil {
			return nil
		}
		if !popupStillOpen(err) {
			break
		}
		time.Sleep(reopenDelay)
	}
	_ = host.NotificationShow("herdr-workflows", "Could not reopen the picker: "+err.Error())
	return err
}

func popupStillOpen(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "popup already open") || strings.Contains(err.Error(), "ui_busy")
}
