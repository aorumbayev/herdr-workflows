// Package host is the Herdr Adapter: explicit host identities, generated
// params/result validation, and a denylist for accidental misuse.
package host

import "strings"

// BinPath finds the herdr binary. If HERDR_BIN_PATH is set, BinPath uses that value.
// Config uses BinPath to find the plugin config directory.
func BinPath(getenv func(string) string) string {
	if v := strings.TrimSpace(getenv("HERDR_BIN_PATH")); v != "" {
		return v
	}
	return "herdr"
}
