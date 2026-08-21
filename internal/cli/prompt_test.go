package cli

import (
	"bufio"
	"bytes"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestSanitizePromptInputStripsC0KeepsEsc(t *testing.T) {
	raw := "a\x00b\tc\nd\x1be"
	got := SanitizePromptInput(raw)
	want := "ab\tc\nd\x1be"
	if got != want {
		t.Fatalf("SanitizePromptInput() = %q, want %q", got, want)
	}
}

func TestInterpretBareEscCancels(t *testing.T) {
	got := interpretLine("hello\x1b")
	if got.Kind != "cancel" {
		t.Fatalf("kind = %q", got.Kind)
	}
}

func TestInterpretEscSequenceIsLine(t *testing.T) {
	got := interpretLine("ok\x1b[A")
	if got.Kind != "line" || got.Text != "ok\x1b[A" {
		t.Fatalf("result = %+v", got)
	}
}

func TestReadLineFromReturnsLine(t *testing.T) {
	r := bufio.NewReader(strings.NewReader("ok\n"))
	got, err := readLineFrom(r)
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != "line" || got.Text != "ok" {
		t.Fatalf("result = %+v", got)
	}
}

func TestReadLineFromEOFWithoutDataCancels(t *testing.T) {
	r := bufio.NewReader(strings.NewReader(""))
	got, err := readLineFrom(r)
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != "cancel" {
		t.Fatalf("kind = %q", got.Kind)
	}
}

func TestReleaseStdinReaderLetsProcessExit(t *testing.T) {
	if os.Getenv("HWF_TEST_READLINE") != "1" {
		cmd := exec.Command(os.Args[0], "-test.run=TestReleaseStdinReaderLetsProcessExit", "-test.count=1")
		cmd.Env = append(os.Environ(), "HWF_TEST_READLINE=1")
		cmd.Stdin = strings.NewReader("ok\n")
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("subprocess failed: %v stderr=%q", err, stderr.String())
			}
		case <-time.After(2 * time.Second):
			_ = cmd.Process.Kill()
			t.Fatal("subprocess did not exit")
		}
		return
	}

	line, err := ReadLine()
	if err != nil {
		t.Fatal(err)
	}
	if line.Kind != "line" || line.Text != "ok" {
		t.Fatalf("line = %+v", line)
	}
	ReleaseStdinReader()
}
