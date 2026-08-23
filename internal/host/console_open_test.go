package host

import "testing"

func TestConsoleOpenParams(t *testing.T) {
	cases := []struct {
		open      string
		placement string
		direction string
		ok        bool
	}{
		{"tab", "tab", "", true},
		{"beside", "split", "right", true},
		{"below", "split", "down", true},
		{"popup", "", "", false},
	}
	for _, tc := range cases {
		got, err := consoleOpenParams(tc.open)
		if !tc.ok {
			if err == nil {
				t.Fatalf("consoleOpenParams(%q) err = nil", tc.open)
			}
			continue
		}
		if err != nil {
			t.Fatalf("consoleOpenParams(%q) err = %v", tc.open, err)
		}
		if got.placement != tc.placement || got.direction != tc.direction {
			t.Fatalf("consoleOpenParams(%q) = %+v, want placement=%q direction=%q",
				tc.open, got, tc.placement, tc.direction)
		}
	}
}
