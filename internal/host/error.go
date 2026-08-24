package host

import (
	"errors"
	"slices"
)

// HerdrError is a typed host failure with a stable, machine-readable code.
// The runner uses transport-loss codes as a sign of uncertain coordination.
type HerdrError struct {
	Code string
	Msg  string
}

func (e *HerdrError) Error() string {
	return e.Msg
}

var transportLossCodes = []string{"closed", "no_socket", "unreachable"}

// IsTransportLoss is true if err is a HerdrError whose code shows that the
// socket or CLI transport is not available.
func IsTransportLoss(err error) bool {
	var herdr *HerdrError
	if !errors.As(err, &herdr) {
		return false
	}
	return slices.Contains(transportLossCodes, herdr.Code)
}
