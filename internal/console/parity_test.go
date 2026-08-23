package console

import "testing"

func TestParityBaselineCoversConsoleScenarios(t *testing.T) {
	rows := ParityBaseline()
	if len(rows) < 6 {
		t.Fatalf("ParityBaseline rows = %d, want at least 6", len(rows))
	}
	for _, row := range rows {
		if row.Spec == "" || row.CoveringTest == "" || row.GoSurface == "" {
			t.Fatalf("incomplete row: %+v", row)
		}
	}
}
