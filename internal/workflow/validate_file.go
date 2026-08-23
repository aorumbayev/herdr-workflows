package workflow

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/config"
)

// ValidateResult is the loader-oracle outcome for a workflow YAML file.
type ValidateResult struct {
	OK    bool
	Error string
}

// ValidateFile reads path and runs the real loader (ParseWorkflowText).
func ValidateFile(path, name, repoRoot string, supplied ...config.Config) ValidateResult {
	body, err := os.ReadFile(path)
	if err != nil {
		return ValidateResult{OK: false, Error: err.Error()}
	}
	if name == "" {
		base := filepath.Base(path)
		name = strings.TrimSuffix(base, filepath.Ext(base))
	}
	cfg, err := configFor(repoRoot, supplied)
	if err != nil {
		return ValidateResult{OK: false, Error: err.Error()}
	}
	if _, err := ParseWorkflowText(name, string(body), cfg, repoRoot, path); err != nil {
		return ValidateResult{OK: false, Error: err.Error()}
	}
	return ValidateResult{OK: true}
}
