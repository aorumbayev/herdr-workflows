package engine

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestGenerateAgentName(t *testing.T) {
	tests := []struct {
		name           string
		stepID         string
		ordinal        int
		suffix         string
		expectedName   string
		shouldValidate bool
	}{
		{
			name:           "basic name with suffix",
			stepID:         "review_step",
			ordinal:        2,
			suffix:         "AB12cd",
			expectedName:   "review_step-ab12cd",
			shouldValidate: true,
		},
		{
			name:           "no step id uses ordinal",
			stepID:         "",
			ordinal:        3,
			suffix:         "ff00",
			expectedName:   "step-3-ff00",
			shouldValidate: true,
		},
		{
			name:           "long prefix is truncated",
			stepID:         strings.Repeat("a", 40),
			ordinal:        1,
			suffix:         "ff00ff",
			expectedName:   "",
			shouldValidate: true,
		},
		{
			name:           "suffix with no alphanumerics falls back to 0",
			stepID:         "my_step",
			ordinal:        1,
			suffix:         "!!!",
			expectedName:   "my_step-0",
			shouldValidate: true,
		},
		{
			name:           "step id starting with digit strips leading non-letters",
			stepID:         "123step",
			ordinal:        5,
			suffix:         "abc",
			expectedName:   "step-abc",
			shouldValidate: true,
		},
	}

	herdrIDPattern := regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := GenerateAgentName(tc.stepID, tc.ordinal, tc.suffix)

			if tc.shouldValidate {
				if len(got) > 32 {
					t.Errorf("GenerateAgentName(%q, %d, %q) length %d exceeds 32", tc.stepID, tc.ordinal, tc.suffix, len(got))
				}
				if !herdrIDPattern.MatchString(got) {
					t.Errorf("GenerateAgentName(%q, %d, %q) = %q, does not match identifier rule", tc.stepID, tc.ordinal, tc.suffix, got)
				}
			}

			if tc.expectedName != "" && got != tc.expectedName {
				t.Errorf("GenerateAgentName(%q, %d, %q) = %q, want %q", tc.stepID, tc.ordinal, tc.suffix, got, tc.expectedName)
			}

			// For the long prefix, make sure that the name ends with the suffix
			if strings.Repeat("a", 40) == tc.stepID {
				if !strings.HasSuffix(got, "-ff00ff") {
					t.Errorf("GenerateAgentName with long prefix should end with -ff00ff, got %q", got)
				}
			}
		})
	}
}

func TestReadManagedResponseOversized(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "big.txt")

	// Create a file larger than CaptureByteLimit
	oversizedData := bytes.Repeat([]byte("a"), caps.CaptureByteLimit+1)
	if err := os.WriteFile(path, oversizedData, 0o600); err != nil {
		t.Fatalf("failed to write oversized file: %v", err)
	}

	_, err := ReadManagedResponse(path)

	var capErr *caps.CaptureLimitError
	if !isCaptureLimitError(err, &capErr) {
		t.Fatalf("ReadManagedResponse returned %T: %v, want *CaptureLimitError", err, err)
	}

	if capErr.Source != "managed response" {
		t.Errorf("source = %q, want %q", capErr.Source, "managed response")
	}

	if capErr.Limit != caps.CaptureByteLimit {
		t.Errorf("limit = %d, want %d", capErr.Limit, caps.CaptureByteLimit)
	}

	if capErr.Bytes != caps.CaptureByteLimit+1 {
		t.Errorf("bytes = %d, want %d", capErr.Bytes, caps.CaptureByteLimit+1)
	}
}

func TestReadManagedResponseMissingAndEmpty(t *testing.T) {
	t.Run("missing file returns herdr error with managed_response_missing code", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "nonexistent.txt")

		_, err := ReadManagedResponse(path)

		var herdrErr *host.HerdrError
		if !isHerdrError(err, &herdrErr) {
			t.Fatalf("ReadManagedResponse returned %T: %v, want *HerdrError", err, err)
		}

		if herdrErr.Code != "managed_response_missing" {
			t.Errorf("code = %q, want %q", herdrErr.Code, "managed_response_missing")
		}

		if !strings.Contains(herdrErr.Msg, path) {
			t.Errorf("error message %q should contain path %q", herdrErr.Msg, path)
		}
	})

	t.Run("empty/whitespace-only file returns herdr error with managed_response_empty code", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "empty.txt")

		if err := os.WriteFile(path, []byte("   \n\n  "), 0o600); err != nil {
			t.Fatalf("failed to write file: %v", err)
		}

		_, err := ReadManagedResponse(path)

		var herdrErr *host.HerdrError
		if !isHerdrError(err, &herdrErr) {
			t.Fatalf("ReadManagedResponse returned %T: %v, want *HerdrError", err, err)
		}

		if herdrErr.Code != "managed_response_empty" {
			t.Errorf("code = %q, want %q", herdrErr.Code, "managed_response_empty")
		}

		if !strings.Contains(herdrErr.Msg, path) {
			t.Errorf("error message %q should contain path %q", herdrErr.Msg, path)
		}
	})
}

func TestReadManagedResponseSuccess(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "response.txt")

	content := "  \n\nThis is my response\n\n  "
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("failed to write file: %v", err)
	}

	got, err := ReadManagedResponse(path)
	if err != nil {
		t.Fatalf("ReadManagedResponse failed: %v", err)
	}

	// The function returns the content verbatim, with surrounding whitespace
	if got != content {
		t.Errorf("ReadManagedResponse returned %q, want %q", got, content)
	}
}

func TestPromptCompositionWithoutExpect(t *testing.T) {
	originalPrompt := "This is the original prompt"
	responsePath := "/tmp/response.txt"

	composed := AppendResponseInstruction(originalPrompt, responsePath, (*workflow.ExpectSpec)(nil))

	if !strings.Contains(composed, originalPrompt) {
		t.Errorf("composed prompt does not contain original prompt")
	}

	if strings.Contains(composed, "Read the absolute path") {
		t.Errorf("composed prompt without expect should not mention 'Read the absolute path'")
	}
}

func TestPromptCompositionWithExpect(t *testing.T) {
	originalPrompt := "review this"
	responsePath := "/tmp/response.txt"
	expect := workflow.ExpectSpec{
		OneOf:   []string{"APPROVE", "REJECT"},
		Require: []string{},
	}

	composed := AppendResponseInstruction(originalPrompt, responsePath, &expect)

	// The text must contain the tokens
	if !strings.Contains(composed, "APPROVE, REJECT") {
		t.Errorf("composed prompt should contain 'APPROVE, REJECT'")
	}

	// The text must mention the final-line rule
	if !strings.Contains(composed, "final non-empty line") {
		t.Errorf("composed prompt should contain 'final non-empty line'")
	}

	// The text must include the response check command with the exact pattern
	pattern := regexp.MustCompile(`hwf response check \S+ --one-of APPROVE,REJECT`)
	if !pattern.MatchString(composed) {
		t.Errorf("composed prompt does not match pattern for response check command")
	}
}

func TestSelfCheckCommandWithSpace(t *testing.T) {
	originalPrompt := "review this"
	responsePath := "/some/path with space/response.txt"
	expect := workflow.ExpectSpec{
		OneOf:   []string{"APPROVE"},
		Require: []string{},
	}

	composed := AppendResponseInstruction(originalPrompt, responsePath, &expect)

	cmdPattern := regexp.MustCompile(`run \x60(hwf response check .+?)\x60 and correct`)
	match := cmdPattern.FindStringSubmatch(composed)
	if len(match) < 2 {
		t.Fatalf("could not extract command from composed prompt")
	}

	command := match[1]
	cmdWithoutHwf := strings.TrimPrefix(command, "hwf ")

	cmd := exec.Command("sh", "-c", "printf '%s\\n' "+cmdWithoutHwf)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		t.Fatalf("failed to run shell split: %v", err)
	}

	argv := strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n")

	expectedArgv := []string{"response", "check", responsePath, "--one-of", "APPROVE"}
	if !slices.Equal(argv, expectedArgv) {
		t.Fatalf("shell split produced %v, want %v", argv, expectedArgv)
	}
}

func TestManagedResponsePath(t *testing.T) {
	tests := []struct {
		runID       string
		stepIndex   int
		responseDir string
		expected    string
	}{
		{
			runID:       "run-123",
			stepIndex:   0,
			responseDir: "/tmp/responses",
			expected:    "/tmp/responses/run-123-step-0.txt",
		},
		{
			runID:       "abc",
			stepIndex:   5,
			responseDir: "/var/tmp",
			expected:    "/var/tmp/abc-step-5.txt",
		},
	}

	for _, tc := range tests {
		t.Run("", func(t *testing.T) {
			got := ManagedResponsePath(tc.runID, tc.stepIndex, tc.responseDir)
			if got != tc.expected {
				t.Errorf("ManagedResponsePath(%q, %d, %q) = %q, want %q",
					tc.runID, tc.stepIndex, tc.responseDir, got, tc.expected)
			}
		})
	}
}

func TestManagedPromptSpillPath(t *testing.T) {
	tests := []struct {
		runID       string
		stepIndex   int
		responseDir string
		expected    string
	}{
		{
			runID:       "run-123",
			stepIndex:   0,
			responseDir: "/tmp/responses",
			expected:    "/tmp/responses/run-123-step-0-prompt.txt",
		},
		{
			runID:       "abc",
			stepIndex:   5,
			responseDir: "/var/tmp",
			expected:    "/var/tmp/abc-step-5-prompt.txt",
		},
	}

	for _, tc := range tests {
		t.Run("", func(t *testing.T) {
			got := ManagedPromptSpillPath(tc.runID, tc.stepIndex, tc.responseDir)
			if got != tc.expected {
				t.Errorf("ManagedPromptSpillPath(%q, %d, %q) = %q, want %q",
					tc.runID, tc.stepIndex, tc.responseDir, got, tc.expected)
			}
		})
	}
}

func TestSpilledPromptInstruction(t *testing.T) {
	spillPath := "/path/to/prompt-file.txt"
	expected := "Read the absolute path /path/to/prompt-file.txt as UTF-8 and follow its instructions exactly. Do not invent content beyond that file."

	got := SpilledPromptInstruction(spillPath)

	if got != expected {
		t.Errorf("SpilledPromptInstruction(%q) = %q, want %q", spillPath, got, expected)
	}
}

func TestApplyVerdict(t *testing.T) {
	t.Run("verdict inside one_of binds", func(t *testing.T) {
		response := "looks fine\nAPPROVE\n"
		expect := workflow.ExpectSpec{
			OneOf:   []string{"APPROVE", "REJECT"},
			Require: []string{},
		}

		verdict, outcome := ApplyVerdict(response, expect, map[string]any{})

		if !outcome.OK {
			t.Fatalf("ApplyVerdict should succeed for valid verdict, got error: %s", outcome.Error)
		}

		if verdict != "APPROVE" {
			t.Errorf("verdict = %q, want %q", verdict, "APPROVE")
		}
	})

	t.Run("unparseable verdict fails naming the tokens", func(t *testing.T) {
		response := "APPROVE — with reservations\n"
		expect := workflow.ExpectSpec{
			OneOf:   []string{"APPROVE", "REJECT"},
			Require: []string{},
		}

		_, outcome := ApplyVerdict(response, expect, map[string]any{})

		if outcome.OK {
			t.Fatalf("ApplyVerdict should fail for invalid verdict")
		}

		if !strings.Contains(outcome.Error, "not a verdict token") {
			t.Errorf("error should mention 'not a verdict token', got: %s", outcome.Error)
		}

		if !strings.Contains(outcome.Error, "APPROVE — with reservations") {
			t.Errorf("error should contain the actual final line, got: %s", outcome.Error)
		}

		if !strings.Contains(outcome.Error, "APPROVE, REJECT") {
			t.Errorf("error should contain expected tokens, got: %s", outcome.Error)
		}
	})

	t.Run("verdict outside require fails naming the verdict and required tokens", func(t *testing.T) {
		response := "no good\nREJECT\n"
		expect := workflow.ExpectSpec{
			OneOf:   []string{"APPROVE", "REJECT"},
			Require: []string{"APPROVE"},
		}

		_, outcome := ApplyVerdict(response, expect, map[string]any{})

		if outcome.OK {
			t.Fatalf("ApplyVerdict should fail when verdict not in require list")
		}

		if !strings.Contains(outcome.Error, "verdict REJECT is not accepted") {
			t.Errorf("error should mention the specific verdict, got: %s", outcome.Error)
		}

		if !strings.Contains(outcome.Error, "requires one of: APPROVE") {
			t.Errorf("error should mention required tokens, got: %s", outcome.Error)
		}

		if _, ok := outcome.Details["verdict"]; !ok {
			t.Errorf("outcome.Details should contain 'verdict' key when verdict is outside require")
		}

		if outcome.Details["verdict"] != "REJECT" {
			t.Errorf("outcome.Details['verdict'] = %q, want %q", outcome.Details["verdict"], "REJECT")
		}
	})
}

// Test helpers.

func isHerdrError(err error, target **host.HerdrError) bool {
	if err == nil {
		return false
	}
	herdrErr, ok := err.(*host.HerdrError)
	if ok && target != nil {
		*target = herdrErr
	}
	return ok
}

func isCaptureLimitError(err error, target **caps.CaptureLimitError) bool {
	if err == nil {
		return false
	}
	capErr, ok := err.(*caps.CaptureLimitError)
	if ok && target != nil {
		*target = capErr
	}
	return ok
}
