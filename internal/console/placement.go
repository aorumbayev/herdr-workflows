package console

import (
	"fmt"
	"strings"
)

// Placement is the position of the console pane relative to the caller.
type Placement string

const (
	PlacementTab    Placement = "tab"
	PlacementBeside Placement = "beside"
	PlacementBelow  Placement = "below"
)

// DefaultPlacement is the first-open console placement.
const DefaultPlacement = PlacementBeside

// ParsePlacement accepts tab, beside, or below. Empty uses DefaultPlacement.
func ParsePlacement(raw string) (Placement, error) {
	v := strings.ToLower(strings.TrimSpace(raw))
	if v == "" {
		return DefaultPlacement, nil
	}
	switch Placement(v) {
	case PlacementTab, PlacementBeside, PlacementBelow:
		return Placement(v), nil
	default:
		return "", fmt.Errorf("placement must be tab, beside, or below")
	}
}
