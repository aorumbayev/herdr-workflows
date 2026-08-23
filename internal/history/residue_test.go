package history

import (
	"os"
	"regexp"
	"testing"
)

func TestNoParseProgressLineResidue(t *testing.T) {
	src, err := os.ReadFile("codec.go")
	if err != nil {
		t.Fatal(err)
	}
	if regexp.MustCompile(`\bParseProgressLine\b`).Match(src) {
		t.Fatal("ParseProgressLine must not exist (tests-only; production only formats progress lines)")
	}
}
