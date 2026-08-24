// Package caps holds the byte caps and their guards. If data is more than a cap,
// the check fails with the source and the limit. The output is not truncated.
package caps

import (
	"fmt"
	"maps"
	"slices"
	"strings"
)

const CaptureByteLimit = 8 * 1024 * 1024

// TranscriptFileByteLimit is the maximum size of a raw claude session file that
// the built-in extractor loads. The transcript cap applies to extracted text.
const TranscriptFileByteLimit = 32 * CaptureByteLimit

// TranscriptRecordByteLimit is the maximum memory for one buffered JSONL record.
// Extracted text of one record can be almost the capture cap. JSON escaping and
// non-text blocks multiply the raw size, so 4x supplies remaining capacity.
const TranscriptRecordByteLimit = 4 * CaptureByteLimit

const HwfEnvByteLimit = 24 * 1024

// AgentPromptByteLimit stays less than the ~21KB body size that herdr
// agent.prompt discards with no message. Oversized prompts write to a run-owned file.
const AgentPromptByteLimit = 16 * 1024

// CaptureLimitError identifies a source that is more than its byte limit.
type CaptureLimitError struct {
	Source string
	Bytes  int
	Limit  int
}

func (e *CaptureLimitError) Error() string {
	return fmt.Sprintf("%s exceeded %d byte limit (%d bytes)", e.Source, e.Limit, e.Bytes)
}

// AssertUnderCaptureCap fails if text is more than the shared capture cap.
func AssertUnderCaptureCap(source, text string) error {
	if len(text) > CaptureByteLimit {
		return &CaptureLimitError{Source: source, Bytes: len(text), Limit: CaptureByteLimit}
	}
	return nil
}

// formatHwfEnvBlock calculates the byte size of the generated HWF_* environment
// block. The function is only for the cap check.
func formatHwfEnvBlock(values map[string]string) string {
	var b strings.Builder
	for _, name := range slices.Sorted(maps.Keys(values)) {
		fmt.Fprintf(&b, "HWF_%s=%s\n", name, values[name])
	}
	return strings.TrimSuffix(b.String(), "\n")
}

// AssertHwfEnvValues fails if the generated HWF_* environment block is more
// than its cap.
func AssertHwfEnvValues(source string, values map[string]string) error {
	block := formatHwfEnvBlock(values)
	if len(block) > HwfEnvByteLimit {
		return &CaptureLimitError{Source: source, Bytes: len(block), Limit: HwfEnvByteLimit}
	}
	return nil
}
