// Package caps owns the byte caps and their guards. Crossing a cap fails
// naming the source and the limit; output is never truncated.
package caps

import (
	"fmt"
	"maps"
	"slices"
	"strings"
)

const CaptureByteLimit = 8 * 1024 * 1024

// TranscriptFileByteLimit bounds how large a raw claude session file the
// built-in extractor will load; the transcript cap applies to extracted text.
const TranscriptFileByteLimit = 32 * CaptureByteLimit

// TranscriptRecordByteLimit bounds the memory one buffered JSONL record can
// hold. One record's extracted text can approach the capture cap and JSON
// escaping plus non-text blocks multiply the raw size, so 4x leaves headroom.
const TranscriptRecordByteLimit = 4 * CaptureByteLimit

const HwfEnvByteLimit = 24 * 1024

// AgentPromptByteLimit stays under the ~21KB body size herdr agent.prompt
// silently drops; oversized prompts spill to a run-owned file.
const AgentPromptByteLimit = 16 * 1024

// CaptureLimitError reports a source that crossed its byte limit.
type CaptureLimitError struct {
	Source string
	Bytes  int
	Limit  int
}

func (e *CaptureLimitError) Error() string {
	return fmt.Sprintf("%s exceeded %d byte limit (%d bytes)", e.Source, e.Limit, e.Bytes)
}

// AssertUnderCaptureCap fails when text crosses the shared capture cap.
func AssertUnderCaptureCap(source, text string) error {
	if len(text) > CaptureByteLimit {
		return &CaptureLimitError{Source: source, Bytes: len(text), Limit: CaptureByteLimit}
	}
	return nil
}

// formatHwfEnvBlock models the byte size of the generated HWF_* environment
// block for the cap check only.
func formatHwfEnvBlock(values map[string]string) string {
	var b strings.Builder
	for _, name := range slices.Sorted(maps.Keys(values)) {
		fmt.Fprintf(&b, "HWF_%s=%s\n", name, values[name])
	}
	return strings.TrimSuffix(b.String(), "\n")
}

// AssertHwfEnvValues fails when the generated HWF_* environment block crosses
// its cap.
func AssertHwfEnvValues(source string, values map[string]string) error {
	block := formatHwfEnvBlock(values)
	if len(block) > HwfEnvByteLimit {
		return &CaptureLimitError{Source: source, Bytes: len(block), Limit: HwfEnvByteLimit}
	}
	return nil
}
