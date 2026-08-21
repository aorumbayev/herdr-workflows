package engine

import (
	"errors"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
)

func TestShellArgv(t *testing.T) {
	cases := []struct {
		name     string
		command  string
		shell    string
		expected []string
	}{
		{
			name:     "defaults to sh when shell is omitted",
			command:  "echo hi",
			shell:    "",
			expected: []string{"sh", "-c", "echo hi"},
		},
		{
			name:     "explicit shell sh",
			command:  "x",
			shell:    "sh",
			expected: []string{"sh", "-c", "x"},
		},
		{
			name:     "explicit shell bash",
			command:  "x",
			shell:    "bash",
			expected: []string{"bash", "-c", "x"},
		},
		{
			name:     "explicit shell zsh",
			command:  "x",
			shell:    "zsh",
			expected: []string{"zsh", "-c", "x"},
		},
		{
			name:     "explicit shell pwsh",
			command:  "x",
			shell:    "pwsh",
			expected: []string{"pwsh", "-NoProfile", "-Command", "x"},
		},
		{
			name:     "explicit shell powershell",
			command:  "x",
			shell:    "powershell",
			expected: []string{"powershell", "-NoProfile", "-Command", "x"},
		},
		{
			name:     "explicit shell cmd",
			command:  "x",
			shell:    "cmd",
			expected: []string{"cmd", "/c", "x"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ShellArgv(tc.command, tc.shell)
			if !slices.Equal(got, tc.expected) {
				t.Fatalf("ShellArgv(%q, %q) = %v, want %v", tc.command, tc.shell, got, tc.expected)
			}
		})
	}
}

func TestNativeProcessTreePlatforms(t *testing.T) {
	if !NativeProcessTree("linux") || !NativeProcessTree("darwin") {
		t.Fatal("linux and darwin must own process-tree termination")
	}
	if NativeProcessTree("windows") {
		t.Fatal("native Windows process-tree support must not exist")
	}
}

func TestKillSpawn(t *testing.T) {
	if !NativeProcessTree(runtime.GOOS) {
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

		// Wait for grandchild PID to be written
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

		// Give it a moment to die
		time.Sleep(100 * time.Millisecond)

		// Verify grandchild is actually dead
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
		// Should not panic
		KillSpawn(cmd)
	})
}

func TestSpawnCaptureBytesCap(t *testing.T) {
	tmpdir := t.TempDir()

	t.Run("stderr flood fails against shared capture budget", func(t *testing.T) {
		// This writes more bytes to stderr than CaptureByteLimit
		argv := []string{"sh", "-c", fmt.Sprintf("head -c %d /dev/zero >&2", caps.CaptureByteLimit+1)}
		result, err := SpawnCapture(argv, CaptureOpts{
			Cwd:              tmpdir,
			MaxCaptureSource: "command",
		})

		if err == nil {
			t.Fatalf("expected error for byte cap overflow, got result: %+v", result)
		}

		var capErr *caps.CaptureLimitError
		if !errors.As(err, &capErr) {
			t.Fatalf("expected *CaptureLimitError, got %T: %v", err, err)
		}

		if capErr.Source != "command" {
			t.Fatalf("expected Source='command', got %q", capErr.Source)
		}

		if capErr.Limit != caps.CaptureByteLimit {
			t.Fatalf("expected Limit=%d, got %d", caps.CaptureByteLimit, capErr.Limit)
		}
	})

	t.Run("split budget across stdout and stderr", func(t *testing.T) {
		// Split the overflow: neither stream alone exceeds the limit,
		// but their sum does
		half := caps.CaptureByteLimit/2 + 10
		argv := []string{"sh", "-c", fmt.Sprintf(
			"head -c %d /dev/zero; head -c %d /dev/zero >&2",
			half, half,
		)}
		result, err := SpawnCapture(argv, CaptureOpts{
			Cwd:              tmpdir,
			MaxCaptureSource: "command",
		})

		if err == nil {
			t.Fatalf("expected error for byte cap overflow, got result: %+v", result)
		}

		var capErr *caps.CaptureLimitError
		if !errors.As(err, &capErr) {
			t.Fatalf("expected *CaptureLimitError, got %T: %v", err, err)
		}

		if capErr.Source != "command" {
			t.Fatalf("expected Source='command', got %q", capErr.Source)
		}
	})
}

func TestSpawnCaptureTimeout(t *testing.T) {
	tmpdir := t.TempDir()
	markerFile := filepath.Join(tmpdir, "alive.txt")

	// The compound command forces sh to fork instead of exec-replace.
	// The grandchild writes "start" to the marker, sleeps, then overwrites it with "done".
	script := fmt.Sprintf("sh -c 'echo start > %q && sleep 0.35 && echo done > %q' && true", markerFile, markerFile)
	argv := ShellArgv(script, "")

	result, err := SpawnCapture(argv, CaptureOpts{
		Cwd:       tmpdir,
		TimeoutMs: 300,
	})
	if err != nil {
		t.Fatalf("SpawnCapture returned error: %v", err)
	}

	if !result.TimedOut {
		t.Fatal("expected TimedOut=true")
	}

	// Check that the marker was written (proving the grandchild launched)
	data, err := os.ReadFile(markerFile)
	if err != nil {
		t.Fatal("marker file was never written - grandchild did not launch")
	}
	if string(data) != "start\n" {
		t.Fatalf("expected marker to be 'start\\n', got %q", string(data))
	}

	// Check marker file hasn't been overwritten after timeout
	deadline := time.Now().Add(900 * time.Millisecond)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(markerFile)
		if err != nil {
			t.Fatalf("failed to read marker: %v", err)
		}
		content := string(data)
		// The marker should still contain "start", not "done"
		if strings.Contains(content, "done") {
			t.Fatal("marker was overwritten after timeout - grandchild was not killed")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestRunArgvStepSuccess(t *testing.T) {
	tmpdir := t.TempDir()
	// Use a direct argv without going through shell to test the argv path
	result, err := RunArgvStep(
		[]string{"printf", "out\nerr\n"},
		ArgvStepOpts{
			Cwd: tmpdir,
		},
	)
	if err != nil {
		t.Fatalf("RunArgvStep returned error: %v", err)
	}

	expected := CommandOutcome{
		OK:       true,
		Stdout:   "out\nerr\n",
		Stderr:   "",
		ExitCode: 0,
		TimedOut: false,
		Failed:   false,
	}

	if result != expected {
		t.Fatalf("RunArgvStep returned %+v, want %+v", result, expected)
	}
}

func TestRunShellStepNonzeroExit(t *testing.T) {
	tmpdir := t.TempDir()
	result, err := RunShellStep(
		"printf nope >&2; exit 3",
		ShellStepOpts{
			Cwd: tmpdir,
		},
	)
	if err != nil {
		t.Fatalf("RunShellStep returned error: %v", err)
	}

	if !result.Failed {
		t.Fatal("expected Failed=true")
	}

	if result.OK {
		t.Fatal("expected OK=false")
	}

	if result.ExitCode != 3 {
		t.Fatalf("expected ExitCode=3, got %d", result.ExitCode)
	}

	if result.Stderr != "nope" {
		t.Fatalf("expected Stderr='nope', got %q", result.Stderr)
	}
}

func TestRunShellStepTimeout(t *testing.T) {
	tmpdir := t.TempDir()
	result, err := RunShellStep(
		"sleep 5",
		ShellStepOpts{
			Cwd:       tmpdir,
			TimeoutMs: 200,
		},
	)
	if err != nil {
		t.Fatalf("RunShellStep returned error: %v", err)
	}

	if !result.TimedOut {
		t.Fatal("expected TimedOut=true")
	}

	if !result.Failed {
		t.Fatal("expected Failed=true")
	}

	expected := "timed out after 0.2s"
	if result.Stderr != expected {
		t.Fatalf("expected Stderr=%q, got %q", expected, result.Stderr)
	}
}

func TestShellStepOptsExtended(t *testing.T) {
	tmpdir := t.TempDir()

	t.Run("SuccessCodes allows exit 3", func(t *testing.T) {
		result, err := RunShellStep(
			"exit 3",
			ShellStepOpts{
				Cwd:          tmpdir,
				SuccessCodes: []int{0, 3},
			},
		)
		if err != nil {
			t.Fatalf("RunShellStep returned error: %v", err)
		}

		if result.Failed {
			t.Fatal("expected Failed=false for exit code 3 in SuccessCodes")
		}

		if !result.OK {
			t.Fatal("expected OK=true for exit code 3 in SuccessCodes")
		}

		if result.ExitCode != 3 {
			t.Fatalf("expected ExitCode=3, got %d", result.ExitCode)
		}
	})

	t.Run("Env variable passed to child", func(t *testing.T) {
		result, err := RunShellStep(
			"echo $TEST_VAR",
			ShellStepOpts{
				Cwd: tmpdir,
				Env: []string{"TEST_VAR=hello"},
			},
		)
		if err != nil {
			t.Fatalf("RunShellStep returned error: %v", err)
		}

		if strings.TrimSpace(result.Stdout) != "hello" {
			t.Fatalf("expected stdout 'hello', got %q", strings.TrimSpace(result.Stdout))
		}
	})

	t.Run("Stdin delivered to child", func(t *testing.T) {
		stdin := "test input"
		result, err := RunShellStep(
			"cat",
			ShellStepOpts{
				Cwd:   tmpdir,
				Stdin: &stdin,
			},
		)
		if err != nil {
			t.Fatalf("RunShellStep returned error: %v", err)
		}

		if result.Stdout != stdin {
			t.Fatalf("expected stdout %q, got %q", stdin, result.Stdout)
		}
	})

	t.Run("explicit shell", func(t *testing.T) {
		result, err := RunShellStep(
			"echo ok",
			ShellStepOpts{
				Cwd:   tmpdir,
				Shell: "sh",
			},
		)
		if err != nil {
			t.Fatalf("RunShellStep returned error: %v", err)
		}

		if strings.TrimSpace(result.Stdout) != "ok" {
			t.Fatalf("expected stdout 'ok', got %q", strings.TrimSpace(result.Stdout))
		}
	})
}

func TestArgvStepOptsExtended(t *testing.T) {
	tmpdir := t.TempDir()

	t.Run("SuccessCodes allows exit 3", func(t *testing.T) {
		result, err := RunArgvStep(
			[]string{"sh", "-c", "exit 3"},
			ArgvStepOpts{
				Cwd:          tmpdir,
				SuccessCodes: []int{0, 3},
			},
		)
		if err != nil {
			t.Fatalf("RunArgvStep returned error: %v", err)
		}

		if result.Failed {
			t.Fatal("expected Failed=false for exit code 3 in SuccessCodes")
		}

		if !result.OK {
			t.Fatal("expected OK=true for exit code 3 in SuccessCodes")
		}
	})

	t.Run("Env variable passed to child", func(t *testing.T) {
		result, err := RunArgvStep(
			[]string{"sh", "-c", "echo $TEST_VAR"},
			ArgvStepOpts{
				Cwd: tmpdir,
				Env: []string{"TEST_VAR=world"},
			},
		)
		if err != nil {
			t.Fatalf("RunArgvStep returned error: %v", err)
		}

		if strings.TrimSpace(result.Stdout) != "world" {
			t.Fatalf("expected stdout 'world', got %q", strings.TrimSpace(result.Stdout))
		}
	})
}

func TestBuildHwfEnv(t *testing.T) {
	inputs := map[string]any{
		"branch": "main",
		"count":  2,
	}
	result := BuildHwfEnv(inputs)

	expected := map[string]string{
		"HWF_branch": "main",
		"HWF_count":  "2",
	}

	if !maps.Equal(result, expected) {
		t.Fatalf("BuildHwfEnv returned %v, want %v", result, expected)
	}
}

func TestMergeStepEnv(t *testing.T) {
	inherited := []string{"PATH=/bin", "HWF_branch=stale"}
	hwf := map[string]string{"HWF_branch": "main"}
	stepEnv := map[string]string{"TOKEN": "t"}

	result := MergeStepEnv(inherited, hwf, stepEnv)

	// Convert to map for easier comparison
	resultMap := make(map[string]string)
	for _, kv := range result {
		parts := strings.SplitN(kv, "=", 2)
		if len(parts) == 2 {
			resultMap[parts[0]] = parts[1]
		}
	}

	expectedMap := map[string]string{
		"PATH":       "/bin",
		"HWF_branch": "main",
		"TOKEN":      "t",
	}

	if !maps.Equal(resultMap, expectedMap) {
		t.Fatalf("MergeStepEnv returned %v, want %v", resultMap, expectedMap)
	}

	// Verify only one entry per key
	keyCount := make(map[string]int)
	for _, kv := range result {
		parts := strings.SplitN(kv, "=", 2)
		if len(parts) == 2 {
			keyCount[parts[0]]++
		}
	}

	for key, count := range keyCount {
		if count != 1 {
			t.Fatalf("key %q appears %d times, expected 1", key, count)
		}
	}
}

func TestCommandFailureStdoutTailUsesRunes(t *testing.T) {
	payload := strings.Repeat("🙂", 600)
	outcome := commandFailure(CommandOutcome{Stdout: payload, ExitCode: 1})
	if !utf8.ValidString(outcome.Error) {
		t.Fatalf("commandFailure error is invalid UTF-8")
	}
	want := string([]rune(payload)[len([]rune(payload))-500:])
	if outcome.Error != want {
		t.Fatalf("commandFailure error = %d runes, want last 500 of payload", len([]rune(outcome.Error)))
	}
}
