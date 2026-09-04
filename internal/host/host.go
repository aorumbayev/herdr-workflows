// Package host is the Herdr Adapter: explicit host identities, generated
// params/result validation, and a denylist for accidental misuse.
package host

import (
	"os"
	"strings"
)

// BinPath finds the herdr binary. If HERDR_BIN_PATH is set, BinPath uses that value.
// Config uses BinPath to find the plugin config directory.
func BinPath() string {
	if v := strings.TrimSpace(os.Getenv("HERDR_BIN_PATH")); v != "" {
		return v
	}
	return "herdr"
}
