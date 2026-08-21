// Package host is the Herdr Adapter: explicit host identities, generated
// params/result validation, and an accidental-misuse denylist.
package host

import "strings"

// BinPath resolves the herdr binary, honoring HERDR_BIN_PATH. Config uses it
// for plugin config-dir discovery.
func BinPath(getenv func(string) string) string {
	if v := strings.TrimSpace(getenv("HERDR_BIN_PATH")); v != "" {
		return v
	}
	return "herdr"
}
