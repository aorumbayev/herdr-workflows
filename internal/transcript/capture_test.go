package transcript

import (
	"strconv"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
)

func TestCaptureCommandBothStreamsShareTheBudget(t *testing.T) {
	res, err := captureCommand([]string{"sh", "-c", "yes out | head -c 200000; yes err | head -c 200000 >&2"}, captureOptions{
		cwd:       t.TempDir(),
		timeoutMs: transcriptTimeoutMs,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.stdout) != 200000 || len(res.stderr) != 200000 {
		t.Fatalf("got stdout=%d stderr=%d", len(res.stdout), len(res.stderr))
	}
}

func TestCaptureCommandCombinedStreamsCrossTheCap(t *testing.T) {
	half := caps.CaptureByteLimit/2 + 1
	script := "yes out | head -c " + strconv.Itoa(half) + " & yes err | head -c " + strconv.Itoa(half) + " >&2; wait"
	_, err := captureCommand([]string{"sh", "-c", script}, captureOptions{
		cwd:       t.TempDir(),
		timeoutMs: transcriptTimeoutMs,
	})
	if err == nil || !strings.Contains(err.Error(), "exceeded") {
		t.Fatalf("got %v, want the combined budget to trip", err)
	}
}

func TestCaptureCommandTimeout(t *testing.T) {
	res, err := captureCommand([]string{"sh", "-c", "sleep 5"}, captureOptions{
		cwd:       t.TempDir(),
		timeoutMs: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.timedOut || res.exitCode != -1 {
		t.Fatalf("got timedOut=%v exitCode=%d", res.timedOut, res.exitCode)
	}
}
