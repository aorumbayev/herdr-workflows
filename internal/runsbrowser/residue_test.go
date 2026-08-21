package runsbrowser

import (
	"os"
	"regexp"
	"testing"
)

func TestNoIsDetailPollableStatusResidue(t *testing.T) {
	src, err := os.ReadFile("format.go")
	if err != nil {
		t.Fatal(err)
	}
	if regexp.MustCompile(`\bIsDetailPollableStatus\b`).Match(src) {
		t.Fatal("IsDetailPollableStatus must not exist (tests-only; Runs refresh does not call it)")
	}
}
