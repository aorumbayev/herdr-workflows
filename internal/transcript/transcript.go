// Package transcript reads agent transcripts. It has a built-in Claude
// .jsonl extractor and, for other agent kinds, runs a configured extractor
// command.
package transcript

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
	"github.com/aorumbayev/herdr-workflows/internal/host"
)

var nonAlnumRE = regexp.MustCompile(`[^a-zA-Z0-9]`)

// Slug must reproduce the project directory name Claude Code writes, which
// comes from a JavaScript `String.replace` over UTF-16 code units: an astral
// rune is two units and becomes two dashes.
func Slug(cwd string) string {
	return nonAlnumRE.ReplaceAllStringFunc(cwd, func(match string) string {
		if r := []rune(match)[0]; r > 0xFFFF {
			return "--"
		}
		return "-"
	})
}

func extractText(content any) string {
	switch c := content.(type) {
	case string:
		return c
	case []any:
		var parts []string
		for _, block := range c {
			m, ok := block.(map[string]any)
			if !ok {
				continue
			}
			if m["type"] == "text" {
				if text, ok := m["text"].(string); ok {
					parts = append(parts, text)
				}
			}
		}
		return strings.Join(parts, "")
	default:
		return ""
	}
}

func extractEntry(line []byte) string {
	if strings.TrimSpace(string(line)) == "" {
		return ""
	}
	var row struct {
		Type    string `json:"type"`
		Message *struct {
			Content any `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(line, &row); err != nil {
		return ""
	}
	if row.Type != "user" && row.Type != "assistant" {
		return ""
	}
	if row.Message == nil || row.Message.Content == nil {
		return ""
	}
	text := extractText(row.Message.Content)
	if text == "" {
		return ""
	}
	return row.Type + ":\n" + text
}

func appendEntry(entries *[]string, transcriptBytes *int, entry string) error {
	next := *transcriptBytes + len(entry)
	if len(*entries) > 0 {
		next += 2
	}
	if next > caps.CaptureByteLimit {
		return &caps.CaptureLimitError{Source: "transcript", Bytes: next, Limit: caps.CaptureByteLimit}
	}
	*entries = append(*entries, entry)
	*transcriptBytes = next
	return nil
}

func consumeLine(line []byte, entries *[]string, transcriptBytes *int) error {
	if len(line) > caps.TranscriptRecordByteLimit {
		return &caps.CaptureLimitError{Source: "transcript record", Bytes: len(line), Limit: caps.TranscriptRecordByteLimit}
	}
	if entry := extractEntry(line); entry != "" {
		return appendEntry(entries, transcriptBytes, entry)
	}
	return nil
}

// consumeChunk drains every complete line out of pending and returns the
// unterminated remainder.
func consumeChunk(pending []byte, entries *[]string, transcriptBytes *int) ([]byte, error) {
	for {
		i := bytes.IndexByte(pending, '\n')
		if i == -1 {
			break
		}
		if err := consumeLine(pending[:i], entries, transcriptBytes); err != nil {
			return nil, err
		}
		pending = pending[i+1:]
	}
	if len(pending) > caps.TranscriptRecordByteLimit {
		return nil, &caps.CaptureLimitError{Source: "transcript record", Bytes: len(pending), Limit: caps.TranscriptRecordByteLimit}
	}
	return pending, nil
}

func readStream(r io.Reader) (string, error) {
	var entries []string
	transcriptBytes := 0
	var pending []byte
	bytesRead := 0
	buf := make([]byte, 64*1024)
	for {
		n, readErr := r.Read(buf)
		if n > 0 {
			bytesRead += n
			if bytesRead > caps.TranscriptFileByteLimit {
				return "", &caps.CaptureLimitError{Source: "transcript file", Bytes: bytesRead, Limit: caps.TranscriptFileByteLimit}
			}
			var err error
			if pending, err = consumeChunk(append(pending, buf[:n]...), &entries, &transcriptBytes); err != nil {
				return "", err
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return "", readErr
		}
	}
	if len(pending) > 0 {
		if err := consumeLine(pending, &entries, &transcriptBytes); err != nil {
			return "", err
		}
	}
	return strings.Join(entries, "\n\n"), nil
}

// ReadClaudeTranscript loads a Claude session .jsonl and returns the extracted
// user/assistant text. base is the projects directory the session lives under.
func ReadClaudeTranscript(cwd, sessionID, base string) (string, error) {
	path := filepath.Join(base, Slug(cwd), sessionID+".jsonl")
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", &host.HerdrError{Code: "transcript_file_missing", Msg: "transcript file not found: " + path}
		}
		return "", &host.HerdrError{Code: "transcript_file_unreadable", Msg: unreadableMsg(path, err)}
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil {
		return "", &host.HerdrError{Code: "transcript_file_unreadable", Msg: unreadableMsg(path, err)}
	}
	if info.Size() > caps.TranscriptFileByteLimit {
		return "", &caps.CaptureLimitError{Source: "transcript file", Bytes: int(info.Size()), Limit: caps.TranscriptFileByteLimit}
	}
	text, err := readStream(f)
	if err != nil {
		var capErr *caps.CaptureLimitError
		if errors.As(err, &capErr) {
			return "", err
		}
		return "", &host.HerdrError{Code: "transcript_file_unreadable", Msg: unreadableMsg(path, err)}
	}
	return text, nil
}

func unreadableMsg(path string, err error) string {
	if err != nil {
		return "transcript file unreadable: " + path + " (" + err.Error() + ")"
	}
	return "transcript file unreadable: " + path
}
