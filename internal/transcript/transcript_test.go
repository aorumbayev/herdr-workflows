package transcript

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
)

func writeSession(t *testing.T, base, cwd, sessionID, content string) {
	t.Helper()
	dir := filepath.Join(base, Slug(cwd))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, sessionID+".jsonl"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func j(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func TestSlug(t *testing.T) {
	cases := map[string]string{
		"/Users/x/y": "-Users-x-y",
		// Claude Code replaces UTF-16 code units, so an astral rune is two dashes.
		"/a/\U0001F642/b": "-a----b",
		"/a/é/b":          "-a---b",
	}
	for cwd, want := range cases {
		if got := Slug(cwd); got != want {
			t.Errorf("Slug(%q) = %q, want %q", cwd, got, want)
		}
	}
}

func TestReadClaudeTranscriptExtracts(t *testing.T) {
	base := t.TempDir()
	jsonl := strings.Join([]string{
		j(map[string]any{"type": "user", "message": map[string]any{"content": "hello"}}),
		"not-json",
		j(map[string]any{"type": "assistant", "message": map[string]any{"content": []any{
			map[string]any{"type": "text", "text": "world"},
			map[string]any{"type": "tool_use", "name": "Bash", "input": map[string]any{}},
			map[string]any{"type": "tool_result", "content": "skip me"},
		}}}),
		j(map[string]any{"type": "assistant", "message": map[string]any{"content": []any{
			map[string]any{"type": "tool_use", "name": "Bash"},
		}}}),
		j(map[string]any{"type": "system", "message": map[string]any{"content": "ignore"}}),
	}, "\n")
	writeSession(t, base, "/Users/x/y", "extract", jsonl+"\n")
	got, err := ReadClaudeTranscript("/Users/x/y", "extract", base)
	if err != nil {
		t.Fatal(err)
	}
	if got != "user:\nhello\n\nassistant:\nworld" {
		t.Fatalf("got %q", got)
	}
}

func TestReadClaudeTranscriptMissingFile(t *testing.T) {
	base := t.TempDir()
	missing := filepath.Join(base, Slug("/Users/x/y"), "nope.jsonl")
	_, err := ReadClaudeTranscript("/Users/x/y", "nope", base)
	if err == nil || !strings.Contains(err.Error(), missing) {
		t.Fatalf("got %v, want error naming %q", err, missing)
	}
}

func TestReadClaudeTranscriptUnterminatedFinalLine(t *testing.T) {
	base := t.TempDir()
	writeSession(t, base, "/repo", "final", j(map[string]any{"type": "assistant", "message": map[string]any{"content": "last"}}))
	got, err := ReadClaudeTranscript("/repo", "final", base)
	if err != nil {
		t.Fatal(err)
	}
	if got != "assistant:\nlast" {
		t.Fatalf("got %q", got)
	}
}

func TestReadClaudeTranscriptOversizedFile(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, Slug("/repo"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "big.jsonl")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	if err := os.Truncate(path, caps.TranscriptFileByteLimit+1); err != nil {
		t.Fatal(err)
	}
	_, err = ReadClaudeTranscript("/repo", "big", base)
	ce, ok := err.(*caps.CaptureLimitError)
	if !ok {
		t.Fatalf("got %v, want CaptureLimitError", err)
	}
	if ce.Source != "transcript file" || ce.Limit != caps.TranscriptFileByteLimit || ce.Bytes != caps.TranscriptFileByteLimit+1 {
		t.Fatalf("got %+v", ce)
	}
}

func TestReadClaudeTranscriptStreamsLargeIgnoredLines(t *testing.T) {
	base := t.TempDir()
	toolNoise := j(map[string]any{
		"type": "user",
		"message": map[string]any{
			"content": []any{map[string]any{"type": "tool_result", "content": strings.Repeat("x", caps.CaptureByteLimit*2)}},
		},
	})
	jsonl := strings.Join([]string{
		j(map[string]any{"type": "user", "message": map[string]any{"content": "small ask"}}),
		toolNoise,
		j(map[string]any{"type": "assistant", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "ok"}}}}),
	}, "\n")
	writeSession(t, base, "/repo", "bulky", jsonl)
	got, err := ReadClaudeTranscript("/repo", "bulky", base)
	if err != nil {
		t.Fatal(err)
	}
	if got != "user:\nsmall ask\n\nassistant:\nok" {
		t.Fatalf("got %q", got)
	}
}

func TestReadClaudeTranscriptRecordCap(t *testing.T) {
	base := t.TempDir()
	ignored := j(map[string]any{"type": "system", "message": map[string]any{"content": strings.Repeat("z", caps.TranscriptRecordByteLimit)}})
	writeSession(t, base, "/repo", "huge-record", ignored+"\n"+j(map[string]any{"type": "user", "message": map[string]any{"content": "after"}})+"\n")
	_, err := ReadClaudeTranscript("/repo", "huge-record", base)
	ce, ok := err.(*caps.CaptureLimitError)
	if !ok {
		t.Fatalf("got %v, want CaptureLimitError", err)
	}
	if ce.Source != "transcript record" || ce.Limit != caps.TranscriptRecordByteLimit {
		t.Fatalf("got %+v", ce)
	}
}

func TestReadClaudeTranscriptTextCap(t *testing.T) {
	base := t.TempDir()
	writeSession(t, base, "/repo", "verbose", j(map[string]any{"type": "user", "message": map[string]any{"content": strings.Repeat("y", caps.CaptureByteLimit+1)}})+"\n")
	_, err := ReadClaudeTranscript("/repo", "verbose", base)
	ce, ok := err.(*caps.CaptureLimitError)
	if !ok {
		t.Fatalf("got %v, want CaptureLimitError", err)
	}
	if ce.Source != "transcript" || ce.Limit != caps.CaptureByteLimit {
		t.Fatalf("got %+v", ce)
	}
}
