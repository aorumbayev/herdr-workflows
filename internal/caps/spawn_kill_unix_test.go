//go:build !windows

package caps

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestKillSpawn(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("process-tree termination is native Linux and macOS")
	}
	t.Run("kills a process group and its grandchild", func(t *testing.T) {
		tmpdir := t.TempDir()
		pidFile := filepath.Join(tmpdir, "grandchild.pid")

		cmd := exec.Command("sh", "-c", fmt.Sprintf("sleep 30 & echo $! > %q; wait", pidFile))
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

		if err := cmd.Start(); err != nil {
			t.Fatalf("failed to start process: %v", err)
		}

		// Wait until the process writes the grandchild PID
		var grandchildPid int
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			data, _ := os.ReadFile(pidFile)
			if len(data) > 0 {
				if _, err := fmt.Sscanf(string(data), "%d", &grandchildPid); err != nil {
					t.Fatalf("unreadable grandchild pid %q: %v", data, err)
				}
				break
			}
			time.Sleep(10 * time.Millisecond)
		}

		if grandchildPid == 0 {
			t.Fatal("grandchild did not write its PID")
		}

		// Kill the process group
		KillSpawn(cmd)
		_ = cmd.Wait()

		// Wait until the process stops
		time.Sleep(100 * time.Millisecond)

		// Make sure that the grandchild process is not alive
		err := syscall.Kill(grandchildPid, 0)
		if !errors.Is(err, syscall.ESRCH) {
			t.Fatalf("grandchild %d should be dead (ESRCH), got %v", grandchildPid, err)
		}
	})

	t.Run("does not panic when process is already gone", func(t *testing.T) {
		cmd := exec.Command("true")
		if err := cmd.Run(); err != nil {
			t.Fatalf("failed to run process: %v", err)
		}
		// The call must not panic
		KillSpawn(cmd)
	})
}
