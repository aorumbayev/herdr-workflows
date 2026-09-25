// Package assets holds files embedded into the binary: the plugin manifest,
// the logo, the workflow schema, and the bundled skills.
package assets

import (
	_ "embed"
	"strings"
)

//go:embed herdr-plugin.toml
var manifest string

//go:embed docs/assets/logo.svg
var LogoSVG string

//go:embed docs/workflow.schema.json
var WorkflowSchemaJSON string

// ManifestVersion reports the plugin version declared by the manifest.
func ManifestVersion() string {
	return manifestField("version")
}

// ManifestDescription reports the plugin description declared by the manifest.
func ManifestDescription() string {
	return manifestField("description")
}

func manifestField(key string) string {
	prefix := key + ` = "`
	for line := range strings.Lines(manifest) {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), prefix); ok {
			return strings.TrimSuffix(v, `"`)
		}
	}
	return ""
}
