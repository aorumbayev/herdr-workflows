package engine

import (
	"maps"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"
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

func TestRunArgvStepSuccess(t *testing.T) {
	tmpdir := t.TempDir()
	// Use a direct argv, not a shell, to test the argv path
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

func TestRunContextEnv(t *testing.T) {
	got := runContextEnv(StepRunOpts{RunID: "run-1", Name: "ship", RepoRoot: "/repo"})
	want := map[string]string{
		"HWF_RUN_ID":        "run-1",
		"HWF_WORKFLOW":      "ship",
		"HWF_CHECKOUT_ROOT": "/repo",
	}
	if !maps.Equal(got, want) {
		t.Fatalf("runContextEnv = %v, want %v", got, want)
	}
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

	// Convert the data to a map for comparison
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

	// Make sure that each key has one entry
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
