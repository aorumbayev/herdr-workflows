// Package assets holds files embedded into the binary. The package
// embeds the plugin manifest so platform code can read the product
// version, and copies of the workbench web bundle so go:embed can
// reach them (patterns cannot leave this directory).
package assets

import (
	_ "embed"
	"strings"
)

// herdr-plugin.toml is a generated copy of the repository-root
// manifest. Run `go run ./scripts/sync-embed` after editing the root.
//
//go:embed herdr-plugin.toml
var manifest string

//go:embed page.html
var PageHTML string

//go:embed field-model.js
var FieldModelJS string

//go:embed logo.svg
var LogoSVG string

//go:embed workflow.schema.json
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
