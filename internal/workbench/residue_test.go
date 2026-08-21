package workbench

import (
	"os"
	"regexp"
	"testing"
)

func TestNoRunWorkbenchRouteResidue(t *testing.T) {
	src, err := os.ReadFile("runs.go")
	if err != nil {
		t.Fatal(err)
	}
	if regexp.MustCompile(`\bRunWorkbenchRoute\b`).Match(src) {
		t.Fatal("RunWorkbenchRoute must not exist (tests-only; runsbrowser.WorkbenchRoute is the production formatter)")
	}
}
