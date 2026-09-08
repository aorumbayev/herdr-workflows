package console

import (
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/tui/paritytest"
)

func TestParityBaselineCoversConsoleScenarios(t *testing.T) {
	ownTests := paritytest.TestFuncs(".")
	externalTests := map[string]map[string]struct{}{
		"tui":      paritytest.TestFuncs("../tui"),
		"picker":   paritytest.TestFuncs("../picker"),
		"workflow": paritytest.TestFuncs("../workflow"),
		"cli":      paritytest.TestFuncs("../cli"),
	}
	rows := ParityBaseline()
	if len(rows) < 6 {
		t.Fatalf("ParityBaseline rows = %d, want at least 6", len(rows))
	}
	for _, row := range rows {
		if row.Spec == "" || row.CoveringTest == "" || row.GoSurface == "" {
			t.Fatalf("incomplete row: %+v", row)
		}
		if !paritytest.Covered(row.CoveringTest, ownTests, externalTests) {
			t.Fatalf("scenario %q CoveringTest %q does not exist", row.Scenario, row.CoveringTest)
		}
	}
}
