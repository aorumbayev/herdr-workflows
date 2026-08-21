package workflow_test

import (
	"os"
	"regexp"
	"testing"
)

func TestNoClausesContainResidue(t *testing.T) {
	src, err := os.ReadFile("template.go")
	if err != nil {
		t.Fatal(err)
	}
	if regexp.MustCompile(`\bClausesContain\b`).Match(src) {
		t.Fatal("ClausesContain must not exist (tests-only duplicate of validate.assertAvailability)")
	}
}
