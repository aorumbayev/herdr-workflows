package host

import (
	"errors"
	"slices"
)

// HerdrError is a typed host failure carrying a stable, machine-readable
// code. The runner treats transport-loss codes as uncertain coordination.
type HerdrError struct {
	Code string
	Msg  string
}

func (e *HerdrError) Error() string {
	return e.Msg
}

var transportLossCodes = []string{"closed", "no_socket", "unreachable"}

// IsTransportLoss reports whether err is a HerdrError whose code means the
// socket or CLI transport was lost.
func IsTransportLoss(err error) bool {
	var herdr *HerdrError
	if !errors.As(err, &herdr) {
		return false
	}
	return slices.Contains(transportLossCodes, herdr.Code)
}
