// Package host resolves the herdr host binary path. The config package
// uses it to discover the plugin config directory.
package host

import "strings"

// BinPath resolves the herdr binary, honoring the HERDR_BIN_PATH override.
func BinPath(getenv func(string) string) string {
	if v := strings.TrimSpace(getenv("HERDR_BIN_PATH")); v != "" {
		return v
	}
	return "herdr"
}
