package caps

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// requireSh skips tests that drive capture through a POSIX shell when the host
// has none. The behavior under test is platform-neutral; only the fixture is not.
func requireSh(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("test fixture needs a POSIX sh")
	}
}

func TestSpawnBytesCap(t *testing.T) {
	requireSh(t)
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
	requireSh(t)
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
