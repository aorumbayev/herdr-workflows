package console

import "testing"

func TestParsePlacement(t *testing.T) {
	cases := []struct {
		in   string
		want Placement
		ok   bool
	}{
		{"tab", PlacementTab, true},
		{"beside", PlacementBeside, true},
		{"below", PlacementBelow, true},
		{"Beside", PlacementBeside, true},
		{"", PlacementBeside, true},
		{"popup", "", false},
		{"split", "", false},
		{"nope", "", false},
	}
	for _, tc := range cases {
		got, err := ParsePlacement(tc.in)
		if tc.ok {
			if err != nil {
				t.Fatalf("ParsePlacement(%q) err = %v", tc.in, err)
			}
			if got != tc.want {
				t.Fatalf("ParsePlacement(%q) = %q, want %q", tc.in, got, tc.want)
			}
			continue
		}
		if err == nil {
			t.Fatalf("ParsePlacement(%q) err = nil, want error", tc.in)
		}
	}
}

func TestDefaultPlacementIsBeside(t *testing.T) {
	if DefaultPlacement != PlacementBeside {
		t.Fatalf("DefaultPlacement = %q, want %q", DefaultPlacement, PlacementBeside)
	}
}
