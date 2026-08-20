package config

import (
	"fmt"
	"os/exec"
	"regexp"
	"runtime"
	"sync"

	assets "github.com/aorumbayev/herdr-workflows/embed"
)

// PlatformName is one of the two native platforms.
type PlatformName string

const (
	PlatformMacOS PlatformName = "macos"
	PlatformLinux PlatformName = "linux"
)

// ProductVersion is the plugin version from the embedded manifest.
var ProductVersion = assets.ManifestVersion()

// ExamplesURL is where the published workflow examples live.
const ExamplesURL = "https://aorumbayev.github.io/herdr-workflows/examples"

// OpenInBrowser opens url in the OS browser. A missing opener is nonfatal.
func OpenInBrowser(url string) {
	name := "xdg-open"
	if runtime.GOOS == "darwin" {
		name = "open"
	}
	cmd := exec.Command(name, url)
	if err := cmd.Start(); err == nil {
		_ = cmd.Process.Release()
	}
}

// WorkflowSchemaURL points at the workflow contract this build implements,
// pinned to the release tag for ProductVersion because schemas diverge
// between versions.
func WorkflowSchemaURL() string {
	return fmt.Sprintf(
		"https://raw.githubusercontent.com/aorumbayev/herdr-workflows/v%s/docs/workflow.schema.json",
		ProductVersion)
}

// Generation is a monotonic latest-wins token: older in-flight work checks
// Current before applying.
type Generation struct {
	mu sync.Mutex
	n  int64
}

// Begin starts a new generation and returns its token.
func (g *Generation) Begin() int64 {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.n++
	return g.n
}

// Current reports whether candidate is the latest generation.
func (g *Generation) Current(candidate int64) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return candidate == g.n
}

var displayControlRE = regexp.MustCompile("[\x00-\x08\x0b\x0c\x0e-\x1f]")

// SanitizeDisplay strips C0 controls from AI/evidence text before writing to
// the terminal (keeps tab/CR/LF).
func SanitizeDisplay(raw string) string {
	return displayControlRE.ReplaceAllString(raw, "")
}

// context: native platforms are Linux and macOS. Windows runs under WSL2,
// where runtime.GOOS is already "linux", so no windows branch can be reached.
func PlatformNameFor(goos string) PlatformName {
	if goos == "darwin" {
		return PlatformMacOS
	}
	return PlatformLinux
}

// Platform reports the current native platform name.
func Platform() PlatformName {
	return PlatformNameFor(runtime.GOOS)
}
