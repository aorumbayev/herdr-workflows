package console

import "testing"

func TestParityBaselineCoversConsoleScenarios(t *testing.T) {
	rows := ParityBaseline()
	if len(rows) < 4 {
		t.Fatalf("ParityBaseline rows = %d, want at least 4", len(rows))
	}
	for _, row := range rows {
		if row.Spec == "" || row.CoveringTest == "" || row.GoSurface == "" {
			t.Fatalf("incomplete row: %+v", row)
		}
	}
}
