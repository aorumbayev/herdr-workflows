package cli

import (
	"bufio"
	"io"
	"os"
	"regexp"
	"strings"
	"sync"
)

// PromptResult is one line of stdin input or a cancel signal.
type PromptResult struct {
	Kind string // "line" or "cancel"
	Text string
}

var (
	stdinReaderMu sync.Mutex
	stdinReader   *bufio.Reader
)

var promptControlRE = regexp.MustCompile(`[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f]`)

func hasBareEsc(raw string) bool {
	for i := 0; i < len(raw); i++ {
		if raw[i] != 0x1b {
			continue
		}
		if i+1 >= len(raw) {
			return true
		}
		next := raw[i+1]
		if next != '[' && next != 'O' {
			return true
		}
	}
	return false
}

// SanitizePromptInput removes unintended C0 controls. It keeps tab, CR, LF, and ESC.
func SanitizePromptInput(raw string) string {
	return promptControlRE.ReplaceAllString(raw, "")
}

func interpretLine(raw string) PromptResult {
	if hasBareEsc(raw) {
		return PromptResult{Kind: "cancel"}
	}
	text := strings.TrimSpace(strings.TrimSuffix(SanitizePromptInput(raw), "\r"))
	return PromptResult{Kind: "line", Text: text}
}

func stdinBufio() *bufio.Reader {
	stdinReaderMu.Lock()
	defer stdinReaderMu.Unlock()
	if stdinReader == nil {
		stdinReader = bufio.NewReader(os.Stdin)
	}
	return stdinReader
}

// ReadLine reads one line from stdin. A bare ESC is a cancel signal.
func ReadLine() (PromptResult, error) {
	return readLineFrom(stdinBufio())
}

func readLineFrom(r *bufio.Reader) (PromptResult, error) {
	line, err := r.ReadString('\n')
	if err != nil {
		if err == io.EOF {
			if line == "" {
				return PromptResult{Kind: "cancel"}, nil
			}
			return interpretLine(line), nil
		}
		return PromptResult{}, err
	}
	return interpretLine(line), nil
}

// ReleaseStdinReader releases the shared stdin reader. Then short-lived commands can exit.
func ReleaseStdinReader() {
	stdinReaderMu.Lock()
	defer stdinReaderMu.Unlock()
	stdinReader = nil
}
