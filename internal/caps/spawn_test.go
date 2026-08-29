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

func TestSpawnBytesCap(t *testing.T) {
	tmpdir := t.TempDir()

	t.Run("stderr flood fails against shared capture budget", func(t *testing.T) {
		// This writes more bytes to stderr than CaptureByteLimit
		argv := []string{"sh", "-c", fmt.Sprintf("head -c %d /dev/zero >&2", CaptureByteLimit+1)}
		result, err := Spawn(argv, SpawnOpts{
			Cwd:              tmpdir,
			MaxCaptureSource: "command",
		})

		if err == nil {
			t.Fatalf("expected error for byte cap overflow, got result: %+v", result)
		}

		var capErr *CaptureLimitError
		if !errors.As(err, &capErr) {
			t.Fatalf("expected *CaptureLimitError, got %T: %v", err, err)
		}

		if capErr.Source != "command" {
			t.Fatalf("expected Source='command', got %q", capErr.Source)
		}

		if capErr.Limit != CaptureByteLimit {
			t.Fatalf("expected Limit=%d, got %d", CaptureByteLimit, capErr.Limit)
		}
	})

	t.Run("split budget across stdout and stderr", func(t *testing.T) {
		// Split the overflow. Neither stream alone exceeds the limit,
		// but the sum of the two streams exceeds the limit.
		half := CaptureByteLimit/2 + 10
		argv := []string{"sh", "-c", fmt.Sprintf(
			"head -c %d /dev/zero; head -c %d /dev/zero >&2",
			half, half,
		)}
		result, err := Spawn(argv, SpawnOpts{
			Cwd:              tmpdir,
			MaxCaptureSource: "command",
		})

		if err == nil {
			t.Fatalf("expected error for byte cap overflow, got result: %+v", result)
		}

		var capErr *CaptureLimitError
		if !errors.As(err, &capErr) {
			t.Fatalf("expected *CaptureLimitError, got %T: %v", err, err)
		}

		if capErr.Source != "command" {
			t.Fatalf("expected Source='command', got %q", capErr.Source)
		}
	})
}

func TestSpawnTimeout(t *testing.T) {
	tmpdir := t.TempDir()
	markerFile := filepath.Join(tmpdir, "alive.txt")

	// The compound command forces sh to fork instead of exec-replace.
	// The grandchild writes "start" to the marker, sleeps, then overwrites it with "done".
	script := fmt.Sprintf("sh -c 'echo start > %q && sleep 0.35 && echo done > %q' && true", markerFile, markerFile)
	argv := []string{"sh", "-c", script}

	result, err := Spawn(argv, SpawnOpts{
		Cwd:       tmpdir,
		TimeoutMs: 300,
	})
	if err != nil {
		t.Fatalf("Spawn returned error: %v", err)
	}

	if !result.TimedOut || result.ExitCode != -1 {
		t.Fatalf("expected TimedOut=true exit=-1, got timedOut=%v exit=%d", result.TimedOut, result.ExitCode)
	}

	// Make sure that the marker exists. This proves that the grandchild started.
	data, err := os.ReadFile(markerFile)
	if err != nil {
		t.Fatal("marker file was never written - grandchild did not launch")
	}
	if string(data) != "start\n" {
		t.Fatalf("expected marker to be 'start\\n', got %q", string(data))
	}

	// Make sure that the marker file was not overwritten after the timeout
	deadline := time.Now().Add(900 * time.Millisecond)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(markerFile)
		if err != nil {
			t.Fatalf("failed to read marker: %v", err)
		}
		content := string(data)
		// The marker must still contain "start", not "done"
		if strings.Contains(content, "done") {
			t.Fatal("marker was overwritten after timeout - grandchild was not killed")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
