package caps

import (
	"errors"
	"strings"
	"testing"
)

func TestCapValues(t *testing.T) {
	cases := map[string]struct{ got, want int }{
		"capture":           {CaptureByteLimit, 8 * 1024 * 1024},
		"transcript file":   {TranscriptFileByteLimit, 256 * 1024 * 1024},
		"transcript record": {TranscriptRecordByteLimit, 32 * 1024 * 1024},
		"hwf env":           {HwfEnvByteLimit, 24 * 1024},
		"agent prompt":      {AgentPromptByteLimit, 16 * 1024},
	}
	for name, c := range cases {
		if c.got != c.want {
			t.Errorf("%s cap = %d, want %d", name, c.got, c.want)
		}
	}
}

func TestAssertUnderCaptureCap(t *testing.T) {
	if err := AssertUnderCaptureCap("src", strings.Repeat("x", CaptureByteLimit)); err != nil {
		t.Fatalf("at-cap value rejected: %v", err)
	}
	err := AssertUnderCaptureCap("cmd stdout", strings.Repeat("x", CaptureByteLimit+1))
	var limitErr *CaptureLimitError
	if !errors.As(err, &limitErr) {
		t.Fatalf("over-cap value did not fail with CaptureLimitError: %v", err)
	}
	if limitErr.Source != "cmd stdout" || limitErr.Bytes != CaptureByteLimit+1 || limitErr.Limit != CaptureByteLimit {
		t.Fatalf("wrong error fields: %+v", limitErr)
	}
	want := "cmd stdout exceeded 8388608 byte limit (8388609 bytes)"
	if err.Error() != want {
		t.Fatalf("message = %q, want %q", err.Error(), want)
	}
}

func TestAssertHwfEnvValues(t *testing.T) {
	if err := AssertHwfEnvValues("hwf env", map[string]string{"A": "1"}); err != nil {
		t.Fatalf("small env rejected: %v", err)
	}
	err := AssertHwfEnvValues("hwf env", map[string]string{"PAD": strings.Repeat("x", HwfEnvByteLimit+1)})
	var limitErr *CaptureLimitError
	if !errors.As(err, &limitErr) {
		t.Fatalf("over-cap env did not fail with CaptureLimitError: %v", err)
	}
	if limitErr.Limit != HwfEnvByteLimit {
		t.Fatalf("limit = %d, want %d", limitErr.Limit, HwfEnvByteLimit)
	}
	if !strings.Contains(err.Error(), "24576") {
		t.Fatalf("message must name the byte limit: %q", err.Error())
	}
}

func TestFormatHwfEnvBlock(t *testing.T) {
	block := formatHwfEnvBlock(map[string]string{"b": "2", "a": "1"})
	if block != "HWF_a=1\nHWF_b=2" {
		t.Fatalf("block = %q", block)
	}
	if formatHwfEnvBlock(nil) != "" {
		t.Fatal("empty values must produce an empty block")
	}
}

func TestAssertUnderFieldPasteCap(t *testing.T) {
	if FieldPasteByteLimit != AgentPromptByteLimit {
		t.Fatalf("FieldPasteByteLimit = %d", FieldPasteByteLimit)
	}
	if err := AssertUnderFieldPasteCap("paste", strings.Repeat("x", FieldPasteByteLimit)); err != nil {
		t.Fatalf("at limit: %v", err)
	}
	err := AssertUnderFieldPasteCap("paste", strings.Repeat("x", FieldPasteByteLimit+1))
	if err == nil {
		t.Fatal("over limit must fail")
	}
	if !strings.Contains(err.Error(), "paste") || !strings.Contains(err.Error(), "16384") {
		t.Fatalf("error must name source and limit: %v", err)
	}
}
